// Compara ambos mecanismos sobre la misma función y el REST real de Asientos.
require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { writeFile } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { setTimeout: esperar } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');

const COLUMNAS = 'clientes,mecanismo,cambio,cliente,asiento_id,tipo,version,publicacion_ms,observacion_ms,demora_ms,estado';
const NO_MEDIDO = 'no medido';

function entero(valor, etiqueta, minimo, maximo) {
  const n = Number(valor);
  if (!/^\d+$/.test(valor) || !Number.isSafeInteger(n) || n < minimo || n > maximo) {
    throw new Error(`${etiqueta} debe ser un entero entre ${minimo} y ${maximo}.`);
  }
  return n;
}

function configurar() {
  const { values } = parseArgs({ options: {
    clientes: { type: 'string', default: '3,10,50' },
    segundos: { type: 'string', default: '60' },
    cambios: { type: 'string', default: '6' },
    'intervalo-polling-ms': { type: 'string', default: '2000' },
    'funcion-id': { type: 'string', default: '41' },
    'asiento-id': { type: 'string' },
    'base-url': { type: 'string' },
    'puerto-local': { type: 'string' },
    csv: { type: 'string', default: 'mediciones-tiempo-real.csv' },
  } });
  const segundos = entero(values.segundos, 'segundos', 1, 3600);
  return {
    clientes: values.clientes.split(',').map((n) => entero(n, 'clientes', 1, 500)),
    segundos,
    cambios: entero(values.cambios, 'cambios', 1, 1000),
    intervalo: entero(values['intervalo-polling-ms'], 'intervalo-polling-ms', 1, segundos * 1000),
    funcionId: entero(values['funcion-id'], 'funcion-id', 1, 2_147_483_647),
    asientoId: values['asiento-id'] && entero(values['asiento-id'], 'asiento-id', 1, 2_147_483_647),
    baseUrl: values['base-url'] || process.env.BASE_URL,
    puertoLocal: values['puerto-local'] && entero(values['puerto-local'], 'puerto-local', 0, 65535),
    csv: values.csv,
  };
}

function crearClienteHttp(base, token) {
  return async (ruta, metodo = 'GET', estado = 200) => {
    const respuesta = await fetch(base + ruta, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (respuesta.status !== estado) {
      await respuesta.body?.cancel();
      throw new Error(`${metodo} ${ruta} devolvió HTTP ${respuesta.status} (esperado ${estado}).`);
    }
    return estado === 204 ? null : respuesta.json();
  };
}

const hasta = (instante) => esperar(Math.max(0, instante - performance.now()));

function conectarWs(url, sockets, registrar, conteos) {
  return new Promise((resolver, rechazar) => {
    const socket = new WebSocket(url, { handshakeTimeout: 8000, closeTimeout: 2000 });
    sockets.push(socket);
    const limite = setTimeout(() => {
      socket.terminate();
      rechazar(new Error('No llegó estado_completo dentro del plazo.'));
    }, 12000);
    socket.on('upgrade', () => { conteos.upgrades += 1; });
    socket.on('message', (datos) => {
      let mensaje;
      try {
        mensaje = JSON.parse(datos.toString());
      } catch {
        clearTimeout(limite);
        socket.terminate();
        rechazar(new Error('El servidor devolvió un mensaje WebSocket inválido.'));
        return;
      }
      if (mensaje.tipo === 'ping') {
        socket.send('{"tipo":"pong"}');
        return;
      }
      conteos.mensajes += 1;
      if (mensaje.tipo === 'estado_completo') {
        clearTimeout(limite);
        resolver();
      } else {
        registrar(mensaje);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(limite);
      rechazar(error);
    });
    socket.once('close', (codigo) => {
      clearTimeout(limite);
      rechazar(new Error(`WebSocket cerrado con código ${codigo} antes de sincronizar.`));
    });
  });
}

function cerrarWs(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolver) => {
    socket.once('close', resolver);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close(1000);
  });
}

async function provocarCambios(pedir, cfg, asiento, inicio, cambios) {
  const detalle = `/api/asientos/${asiento.id}`;
  for (let i = 0; i < cfg.cambios; i += 1) {
    await hasta(inicio + (i + 1) * cfg.segundos * 1000 / (cfg.cambios + 1));
    if (i % 2 === 0) {
      const bloqueado = await pedir(detalle + '/bloqueo', 'POST');
      cambios.push({ tipo: 'asiento_bloqueado', version: bloqueado.version });
    } else {
      await pedir(detalle + '/bloqueo', 'DELETE', 204);
      const libre = await pedir(detalle);
      if (libre.estado !== 'libre') throw new Error('Se encontró un cambio ajeno en el asiento de prueba.');
      cambios.push({ tipo: 'asiento_liberado', version: libre.version });
    }
  }
}

async function hacerPolling(pedir, cfg, asiento, inicio, observar, conteos) {
  for (let ms = Math.min(cfg.intervalo / 2, 500); ms < cfg.segundos * 1000; ms += cfg.intervalo) {
    await hasta(inicio + ms);
    await Promise.all(observar.map(async (registrar) => {
      conteos.pollingEnviado += 1;
      try {
        const grilla = await pedir(`/api/asientos?funcionId=${cfg.funcionId}`);
        const actual = grilla.asientos.find((a) => a.id === asiento.id);
        if (actual) registrar(actual);
        conteos.pollingExitoso += 1;
      } catch {
        conteos.pollingFallido += 1;
      }
    }));
  }
}

function resumir(demoras, esperadas) {
  if (demoras.length !== esperadas || esperadas === 0) {
    return { demoraPromedioMs: NO_MEDIDO, demoraP95Ms: NO_MEDIDO, demoraMaximaMs: NO_MEDIDO };
  }
  const ordenadas = demoras.toSorted((a, b) => a - b);
  const redondear = (n) => Number(n.toFixed(3));
  return {
    demoraPromedioMs: redondear(demoras.reduce((suma, n) => suma + n, 0) / demoras.length),
    demoraP95Ms: redondear(ordenadas[Math.ceil(ordenadas.length * 0.95) - 1]),
    demoraMaximaMs: redondear(ordenadas.at(-1)),
  };
}

async function medirFase({ cfg, pedir, adaptador, asiento, urlWs }, clientes, mecanismo, filas) {
  const sockets = [];
  const publicaciones = new Map();
  const observaciones = Array.from({ length: clientes }, () => new Map());
  const observar = observaciones.map((versiones) => (mensaje) => {
    if ((mensaje.asientoId ?? mensaje.id) === asiento.id && !versiones.has(mensaje.version)) {
      versiones.set(mensaje.version, performance.now());
    }
  });
  const cambios = [];
  const conteos = { upgrades: 0, mensajes: 0, pollingEnviado: 0, pollingExitoso: 0, pollingFallido: 0 };
  const medirWs = mecanismo === 'WebSocket';
  const marcarPublicacion = (m) => {
    if (m.asientoId === asiento.id) publicaciones.set(m.version, performance.now());
  };
  const desuscribir = adaptador?.suscribirCambios(marcarPublicacion, { primero: true });
  console.log(JSON.stringify({ evento: 'medicion_inicio', clientes, mecanismo }));
  try {
    const antes = medirWs ? await pedir('/api/metricas/conexiones') : null;
    if (medirWs) await Promise.all(observar.map((registrar) => conectarWs(urlWs, sockets, registrar, conteos)));
    const inicio = performance.now();
    const resultados = await Promise.allSettled([
      provocarCambios(pedir, cfg, asiento, inicio, cambios),
      medirWs ? hasta(inicio + cfg.segundos * 1000) : hacerPolling(pedir, cfg, asiento, inicio, observar, conteos),
    ]);
    for (const resultado of resultados) {
      if (resultado.status === 'rejected') throw resultado.reason;
    }
    await hasta(inicio + cfg.segundos * 1000);

    const demoras = [];
    let observadas = 0;
    cambios.forEach(({ tipo, version }, i) => {
      const publicacion = publicaciones.get(version);
      observaciones.forEach((versiones, cliente) => {
        const observacion = versiones.get(version);
        const demora = publicacion == null || observacion == null ? null : observacion - publicacion;
        if (observacion != null) observadas += 1;
        if (demora != null) demoras.push(demora);
        const estado = observacion == null ? 'no_observado' : demora == null ? 'sin_reloj_servidor' : 'medido';
        filas.push([clientes, mecanismo, i + 1, cliente + 1, asiento.id, tipo, version,
          publicacion?.toFixed(6) ?? '', observacion?.toFixed(6) ?? '', demora?.toFixed(6) ?? '', estado].join(','));
      });
    });

    const medido = medirWs
      ? (await pedir('/api/metricas/conexiones')).mensajesEmitidos - antes.mensajesEmitidos
      : (await pedir(`/api/metricas/solicitudes?ventanaSegundos=${cfg.segundos}`)).solicitudesPolling;
    const coincide = medirWs
      ? medido === conteos.mensajes && conteos.upgrades === clientes
      : medido === conteos.pollingEnviado && !conteos.pollingFallido;
    const esperadas = clientes * cfg.cambios;
    const latencias = resumir(demoras, esperadas);
    const total = medirWs ? medido + conteos.upgrades : medido;
    const solicitudesPorMinuto = coincide ? Number((total * 60 / cfg.segundos).toFixed(3)) : NO_MEDIDO;
    const resultado = {
      evento: 'medicion_resultado', clientes, mecanismo, segundos: cfg.segundos,
      cambios: cambios.length, observadas, esperadas, medidoPorEndpoint: medido, ...conteos,
      solicitudesPorMinuto, ...latencias,
    };
    if (!coincide) resultado.motivoVolumen = 'El endpoint y el cliente difieren o fallaron solicitudes.';
    if (!adaptador) resultado.motivoLatencia = 'El servidor corre en otro proceso y no comparte el reloj de medición.';
    else if (demoras.length !== esperadas) resultado.motivoLatencia = 'Faltan observaciones o publicaciones para alguna versión.';
    console.log(JSON.stringify(resultado));
    return coincide && (!adaptador || demoras.length === esperadas);
  } finally {
    desuscribir?.();
    await Promise.all(sockets.map(cerrarWs));
    // Una fase impar o interrumpida puede dejar un bloqueo de este usuario de prueba.
    const actual = await pedir(`/api/asientos/${asiento.id}`);
    if (actual.estado === 'bloqueado' && actual.bloqueadoPor === cfg.usuario) {
      await pedir(`/api/asientos/${asiento.id}/bloqueo`, 'DELETE', 204);
    }
  }
}

async function principal() {
  const cfg = configurar();
  const secreto = process.env.JWT_SECRET;
  if (!secreto) throw new Error('Configurá JWT_SECRET con el secreto de la instancia de prueba.');
  cfg.usuario = `medicion-${randomUUID().slice(0, 8)}`;
  const token = jwt.sign({ sub: cfg.usuario }, secreto, { algorithm: 'HS256', expiresIn: '4h' });
  const filas = [COLUMNAS];
  let local, adaptador;
  try {
    if (!cfg.baseUrl || cfg.puertoLocal !== undefined) {
      adaptador = require('../src/tiempo-real/adaptador-asientos');
      local = require('../src/tiempo-real/servidor-integrado').crearServidor({ log: () => {} });
      const escuchando = once(local.servidor, 'listening');
      local.servidor.listen(cfg.puertoLocal ?? 0, '127.0.0.1');
      await escuchando;
    }
    const base = (cfg.baseUrl || `http://127.0.0.1:${local.servidor.address().port}`).replace(/\/+$/, '');
    const pedir = crearClienteHttp(base, token);
    const grilla = local
      ? await adaptador.obtenerEstadoCompleto(cfg.funcionId)
      : await pedir(`/api/asientos?funcionId=${cfg.funcionId}`);
    const asiento = grilla?.asientos.find((a) => a.estado === 'libre' && (!cfg.asientoId || a.id === cfg.asientoId));
    if (!asiento) throw new Error('No se encontró un asiento libre para la medición.');

    const urlWs = new URL(`${base.replace(/^http/, 'ws')}/ws/sala/${cfg.funcionId}`);
    urlWs.searchParams.set('token', token);
    console.log(JSON.stringify({
      evento: 'configuracion_medicion', node: process.version, base,
      reloj: adaptador ? 'performance.now() poscommit en el proceso de Asientos' : NO_MEDIDO,
      clientes: cfg.clientes, segundosPorFase: cfg.segundos, cambiosPorFase: cfg.cambios,
      intervaloPollingMs: cfg.intervalo, funcionId: cfg.funcionId, asientoId: asiento.id,
    }));
    for (const clientes of cfg.clientes) {
      for (const mecanismo of ['WebSocket', 'Polling']) {
        try {
          if (!await medirFase({ cfg, pedir, adaptador, asiento, urlWs }, clientes, mecanismo, filas)) process.exitCode = 1;
        } catch (error) {
          console.error(JSON.stringify({
            evento: 'medicion_incompleta', clientes, mecanismo,
            estado: 'NO EJECUTADO', resultado: NO_MEDIDO, motivo: error.message,
          }));
          process.exitCode = 1;
        }
      }
    }
  } finally {
    if (local) await local.cerrar();
    await writeFile(cfg.csv, filas.join('\n') + '\n');
  }
}

principal().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
