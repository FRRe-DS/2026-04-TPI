const { test, before, after } = require('node:test');

if (process.env.npm_lifecycle_event === 'test') {
  test('suite de tiempo real (npm run test:tiempo-real)', { skip: true }, () => {});
} else {
  registrarPruebas();
}

function registrarPruebas() {
  const assert = require('node:assert/strict');
  const { createHash, randomBytes, randomUUID } = require('node:crypto');
  const { once } = require('node:events');
  const { performance } = require('node:perf_hooks');
  const { setTimeout: esperar } = require('node:timers/promises');
  const jwt = require('jsonwebtoken');
  const { WebSocket } = require('ws');
  const mysql = require('mysql2/promise');

  require('dotenv').config({ quiet: true });
  const baseExterna = process.env.BASE_URL?.replace(/\/+$/, '');
  const funcionId = baseExterna ? Number(process.env.FUNCION_ID || 41) : 41;
  const otraFuncionId = baseExterna ? Number(process.env.OTRA_FUNCION_ID || 42) : 42;
  const usuario = `prueba-${randomUUID().slice(0, 8)}`;
  const rutaGrilla = (id) => `/api/asientos?funcionId=${id}`;
  const rutaAsiento = (id) => `/api/asientos/${id}`;
  const logs = [];
  const fixtures = [];
  let base = baseExterna;
  let token, servicio, admin, esquemaDePrueba;
  let entregarCambio, pausarCambios = false;
  let antesDeGrilla, despuesDeGrilla;

  function pedir(ruta, { metodo = 'GET', autorizacion = token } = {}) {
    return fetch(base + ruta, {
      method: metodo,
      headers: autorizacion ? { Authorization: `Bearer ${autorizacion}` } : {},
      signal: AbortSignal.timeout(5000),
    });
  }

  async function json(ruta, opciones) {
    const respuesta = await pedir(ruta, opciones);
    assert.equal(respuesta.status, 200, ruta);
    return respuesta.json();
  }

  const bloquear = (id) => json(rutaAsiento(id) + '/bloqueo', { metodo: 'POST' });
  async function liberar(id) {
    const respuesta = await pedir(rutaAsiento(id) + '/bloqueo', { metodo: 'DELETE' });
    assert.equal(respuesta.status, 204);
  }

  function capturarHandshake(solicitud, respuesta) {
    const cabeceras = solicitud.getHeaders();
    const ruta = solicitud.path.split('?')[0];
    return [
      `${solicitud.method} ${ruta}?token=[REDACTADO] HTTP/1.1`,
      `Host: ${cabeceras.host}`,
      `Upgrade: ${cabeceras.upgrade}`,
      `Connection: ${cabeceras.connection}`,
      `Sec-WebSocket-Key: ${cabeceras['sec-websocket-key']}`,
      `Sec-WebSocket-Version: ${cabeceras['sec-websocket-version']}`,
      '',
      `HTTP/${respuesta.httpVersion} ${respuesta.statusCode} ${respuesta.statusMessage}`,
      `Upgrade: ${respuesta.headers.upgrade}`,
      `Connection: ${respuesta.headers.connection}`,
      `Sec-WebSocket-Accept: ${respuesta.headers['sec-websocket-accept']}`,
    ].join('\n');
  }

  function conectar(t, id = funcionId, { jwtToken = token, responderPong = true } = {}) {
    const url = new URL(`${base.replace(/^http/, 'ws')}/ws/sala/${id}`);
    if (jwtToken) url.searchParams.set('token', jwtToken);
    const cliente = { mensajes: [] };
    const ws = new WebSocket(url, {
      handshakeTimeout: 5000,
      closeTimeout: 1000,
      finishRequest(solicitud) {
        cliente.solicitud = solicitud;
        solicitud.end();
      },
    });
    cliente.ws = ws;
    ws.on('error', () => {});
    ws.on('upgrade', (res) => { cliente.handshake = res; });
    ws.on('message', (datos) => {
      const mensaje = JSON.parse(datos.toString());
      if (mensaje.tipo === 'ping' && responderPong) ws.send('{"tipo":"pong"}');
      cliente.mensajes.push(mensaje);
    });
    t.after(() => cerrar(ws));
    return cliente;
  }

  function cerrar(ws) {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolver) => {
      ws.once('close', resolver);
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000);
    });
  }

  async function hasta(condicion, mensaje, plazo = 5000) {
    const limite = performance.now() + plazo;
    while (!condicion()) {
      if (performance.now() >= limite) assert.fail(mensaje);
      await esperar(10);
    }
  }

  async function recibir(cliente, tipo, asientoId, version) {
    let encontrado;
    await hasta(() => {
      encontrado = cliente.mensajes.find((m) => m.tipo === tipo &&
        (asientoId == null || m.asientoId === asientoId) && (version == null || m.version === version));
      return encontrado;
    }, `No se recibió ${tipo}`);
    return encontrado;
  }

  function barrera() {
    let liberar;
    const espera = new Promise((resolver) => { liberar = resolver; });
    return { espera, liberar };
  }

  function mensajeCambio(tipo, asiento, extra) {
    const { id: asientoId, fila, numero, version } = asiento;
    return { tipo, asientoId, fila, numero, version, ...extra };
  }

  before(async () => {
    assert.ok(!baseExterna || process.env.JWT_SECRET, 'Configurá JWT_SECRET para probar contra BASE_URL.');
    process.env.JWT_SECRET ||= randomBytes(32).toString('hex');
    token = jwt.sign({ sub: usuario }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    if (baseExterna) return;

    process.env.SEGUNDOS_BLOQUEO = '2';
    process.env.INTERVALO_VENCIMIENTO_MS = '100';
    process.env.WS_PING_INTERVAL_MS = '180';
    process.env.WS_MAX_PAYLOAD_BYTES = '128';
    const esquemaBase = process.env.DB_NAME || 'asientos_db';
    const esquemaNuevo = `asientos_tr_${randomBytes(8).toString('hex')}`;
    admin = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
    });
    await admin.query('CREATE DATABASE ??', [esquemaNuevo]);
    esquemaDePrueba = esquemaNuevo;
    await admin.query('CREATE TABLE ??.asientos LIKE ??.asientos', [esquemaDePrueba, esquemaBase]);
    process.env.DB_NAME = esquemaDePrueba;

    const adaptador = require('../src/tiempo-real/adaptador-asientos');
    for (let i = 1; i <= 8; i += 1) {
      const [insercion] = await admin.query(
        'INSERT INTO ??.asientos (funcion_id, fila, numero) VALUES (?, ?, ?)',
        [esquemaDePrueba, i === 8 ? otraFuncionId : funcionId, 'A', i]
      );
      fixtures.push(insercion.insertId);
    }
    servicio = require('../src/tiempo-real/servidor-integrado').crearServidor({
      log: (linea) => logs.push(linea),
      adaptador: {
        ...adaptador,
        async obtenerEstadoCompleto(id) {
          await antesDeGrilla?.(id);
          const grilla = await adaptador.obtenerEstadoCompleto(id);
          await despuesDeGrilla?.(id);
          return grilla;
        },
        suscribirCambios(oyente) {
          entregarCambio = oyente;
          return adaptador.suscribirCambios((mensaje) => {
            if (!pausarCambios) oyente(mensaje);
          });
        },
      },
    });
    servicio.servidor.listen(0, '127.0.0.1');
    await once(servicio.servidor, 'listening');
    base = `http://127.0.0.1:${servicio.servidor.address().port}`;
  });

  after(async () => {
    try {
      if (servicio) await servicio.cerrar();
    } finally {
      if (admin) {
        try {
          if (esquemaDePrueba) await admin.query('DROP DATABASE ??', [esquemaDePrueba]);
        } finally {
          await admin.end();
        }
      }
    }
  });

  test('estrella: un bloqueo por REST llega a los dos sockets de su función y a ninguno de la otra', async (t) => {
    const clientes = [conectar(t), conectar(t), conectar(t, otraFuncionId)];
    const [primera, segunda, tercera] = await Promise.all(clientes.map((cliente) => recibir(cliente, 'estado_completo')));
    assert.equal(primera.grilla.funcionId, funcionId);
    assert.equal(segunda.grilla.funcionId, funcionId);
    assert.equal(tercera.grilla.funcionId, otraFuncionId);
    const id = primera.grilla.asientos.find((a) => a.estado === 'libre' &&
      (!baseExterna || !process.env.ASIENTO_ID || a.id === Number(process.env.ASIENTO_ID)))?.id;
    assert.ok(id, 'La función de prueba necesita un asiento libre.');
    t.after(async () => {
      const actual = await json(rutaAsiento(id));
      if (actual.bloqueadoPor === usuario) await liberar(id);
    });

    const a = await bloquear(id);
    const esperado = mensajeCambio('asiento_bloqueado', a, { bloqueadoHasta: a.bloqueadoHasta });
    assert.ok(Number.isFinite(Date.parse(esperado.bloqueadoHasta)));
    assert.deepEqual(await recibir(clientes[0], esperado.tipo, id), esperado);
    assert.deepEqual(await recibir(clientes[1], esperado.tipo, id), esperado);
    await esperar(140);
    assert.equal(clientes[2].mensajes.filter((m) => m.tipo.startsWith('asiento_')).length, 0);

    const upgrade = clientes[0].handshake;
    assert.equal(upgrade.statusCode, 101);
    const key = clientes[0].solicitud.getHeader('sec-websocket-key');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.equal(upgrade.headers['sec-websocket-accept'], accept);
    t.diagnostic(capturarHandshake(clientes[0].solicitud, upgrade));
  });

  if (!baseExterna) {
    test('estado_completo es el primer mensaje y coincide con la grilla REST', async (t) => {
      const cliente = conectar(t);
      const estado = await recibir(cliente, 'estado_completo');
      assert.equal(cliente.mensajes[0], estado);
      assert.deepEqual(Object.keys(estado).sort(), ['grilla', 'tipo']);
      const grillaRest = await json(rutaGrilla(funcionId));
      assert.equal(estado.grilla.funcionId, grillaRest.funcionId);
      assert.ok(Number.isFinite(Date.parse(estado.grilla.generadoEn)));
      assert.deepEqual(estado.grilla.asientos, grillaRest.asientos);
    });

    test('reconexión recupera un cambio hecho mientras el cliente estaba desconectado', async (t) => {
      const anterior = conectar(t);
      await recibir(anterior, 'estado_completo');
      await cerrar(anterior.ws);
      const a = await bloquear(fixtures[1]);
      const nueva = await recibir(conectar(t), 'estado_completo');
      assert.deepEqual(nueva.grilla.asientos.find((s) => s.id === a.id), a);
      await liberar(a.id);
    });

    test('emite la liberación manual y la venta con las versiones confirmadas', async (t) => {
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const a = await bloquear(fixtures[2]);
      await recibir(cliente, 'asiento_bloqueado', a.id, a.version);
      await liberar(a.id);
      const libre = await json(rutaAsiento(a.id));
      assert.equal(libre.version, a.version + 1);
      assert.deepEqual(await recibir(cliente, 'asiento_liberado', a.id),
        mensajeCambio('asiento_liberado', libre, { motivo: 'liberado_por_usuario' }));

      const otroBloqueo = await bloquear(a.id);
      await recibir(cliente, 'asiento_bloqueado', a.id, otroBloqueo.version);
      const vendido = await json(rutaAsiento(a.id) + '/confirmacion', { metodo: 'POST' });
      assert.equal(vendido.estado, 'vendido');
      assert.deepEqual(await recibir(cliente, 'asiento_vendido', a.id), mensajeCambio('asiento_vendido', vendido));
      const nueva = await recibir(conectar(t), 'estado_completo');
      const vendidoWs = nueva.grilla.asientos.find((s) => s.id === a.id);
      assert.deepEqual(vendidoWs, { ...vendido, bloqueadoPor: null });
    });

    test('el vencimiento natural en MySQL emite una sola liberación y deja el asiento libre por REST', async (t) => {
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const a = await bloquear(fixtures[3]);
      const vencido = await recibir(cliente, 'asiento_liberado', a.id);
      const actual = await json(rutaAsiento(a.id));
      assert.equal(actual.estado, 'libre');
      assert.equal(actual.version, a.version + 1);
      assert.deepEqual(vencido, mensajeCambio('asiento_liberado', actual, { motivo: 'bloqueo_vencido' }));
      await esperar(240);
      assert.equal(cliente.mensajes.filter((m) => m.tipo === 'asiento_liberado' && m.asientoId === a.id).length, 1);
    });

    test('latido JSON: expulsa al cliente que no responde y mantiene al que envía pong', async (t) => {
      const mudo = conectar(t, funcionId, { responderPong: false });
      const vivo = conectar(t);
      await Promise.all([recibir(mudo, 'estado_completo'), recibir(vivo, 'estado_completo')]);
      assert.equal((await json('/api/metricas/conexiones')).conexionesActivas, 2);
      const cierre = once(mudo.ws, 'close', { signal: AbortSignal.timeout(3000) });
      await recibir(mudo, 'ping');
      assert.deepEqual((await cierre).slice(0, 1), [1006]);
      const metricas = await json('/api/metricas/conexiones');
      assert.deepEqual(metricas.conexionesPorFuncion, { [funcionId]: 1 });
      assert.equal(vivo.ws.readyState, WebSocket.OPEN);
      assert.ok(logs.some((linea) => JSON.parse(linea).evento === 'ws_ping_fallido'));
    });

    test('JWT ausente, con firma inválida o vencido cierra con 1008 sin registrar el token', async (t) => {
      const invalido = jwt.sign({ sub: usuario }, randomBytes(32), { algorithm: 'HS256', expiresIn: '10m' });
      const vencido = jwt.sign({ sub: usuario }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -60 });
      for (const jwtToken of [null, invalido, vencido]) {
        const cliente = conectar(t, funcionId, { jwtToken });
        const [codigo] = await once(cliente.ws, 'close', { signal: AbortSignal.timeout(5000) });
        assert.equal(codigo, 1008);
        assert.equal(cliente.mensajes.length, 0);
      }
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const secretoEnMensaje = 'dato-privado-para-test';
      cliente.ws.send(JSON.stringify({ tipo: 'otro', token: secretoEnMensaje }));
      await hasta(() => logs.some((linea) => JSON.parse(linea).evento === 'ws_mensaje_ignorado'), 'Falta log de mensaje ignorado');
      for (const secreto of [token, invalido, vencido, secretoEnMensaje]) {
        assert.equal(logs.some((linea) => linea.includes(secreto)), false);
      }
    });

    test('función inexistente responde HTTP 404 antes del upgrade', async (t) => {
      const cliente = conectar(t, 2_147_483_647);
      const [, res] = await once(cliente.ws, 'unexpected-response', { signal: AbortSignal.timeout(5000) });
      assert.equal(res.statusCode, 404);
      assert.equal(cliente.handshake, undefined);
      res.resume();
    });

    test('un error después del upgrade cierra con 1011 y limpia la sala', async (t) => {
      antesDeGrilla = () => { throw new Error('fallo de grilla provocado por el test'); };
      t.after(() => { antesDeGrilla = null; });
      const cliente = conectar(t);
      const [codigo] = await once(cliente.ws, 'close', { signal: AbortSignal.timeout(5000) });
      assert.equal(codigo, 1011);
      assert.equal(cliente.handshake.statusCode, 101);
      assert.equal((await json('/api/metricas/conexiones')).conexionesActivas, 0);
    });

    test('un mensaje por encima de maxPayload cierra con 1009', async (t) => {
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const cierre = once(cliente.ws, 'close', { signal: AbortSignal.timeout(5000) });
      cliente.ws.send('x'.repeat(129));
      assert.equal((await cierre)[0], 1009);
    });

    test('métricas autenticadas: conexión, grilla, ping excluido y ventana de polling', async (t) => {
      const inicial = await json('/api/metricas/conexiones');
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      await recibir(cliente, 'ping');
      assert.deepEqual(await json('/api/metricas/conexiones'), {
        conexionesActivas: 1,
        conexionesPorFuncion: { [funcionId]: 1 },
        mensajesEmitidos: inicial.mensajesEmitidos + 1,
      });
      await cerrar(cliente.ws);

      let conexionesActivas;

      for (let intento = 0; intento < 100; intento++) {
        conexionesActivas =
          (await json('/api/metricas/conexiones')).conexionesActivas;

        if (conexionesActivas === 0) break;

        await esperar(20);
      }

      assert.equal(conexionesActivas, 0);

      const ruta = '/api/metricas/solicitudes';
      const inicialPolling = await json(ruta);
      assert.equal(inicialPolling.ventanaSegundos, 60);
      assert.equal((await pedir(ruta, { autorizacion: null })).status, 401);
      assert.equal((await pedir(ruta + '?ventanaSegundos=3601')).status, 400);
      assert.equal((await pedir('/api/asientos')).status, 400);
      assert.equal((await pedir(rutaGrilla(funcionId), { autorizacion: null })).status, 401);
      assert.equal((await pedir(rutaGrilla(funcionId), { metodo: 'HEAD' })).status, 200);
      assert.equal((await json(ruta)).solicitudesPolling, inicialPolling.solicitudesPolling);
      await json(rutaGrilla(funcionId));
      assert.equal((await json(ruta)).solicitudesPolling, inicialPolling.solicitudesPolling + 1);
      assert.ok((await json(ruta + '?ventanaSegundos=1')).solicitudesPolling >= 1);
      await esperar(1100);
      assert.deepEqual(await json(ruta + '?ventanaSegundos=1'), { ventanaSegundos: 1, solicitudesPolling: 0 });
    });

    test('contador conserva la ventana máxima y descarta registros anteriores al borde', () => {
      const { crearContadorPolling } = require('../src/tiempo-real/metricas');
      let ahora = 0;
      const contador = crearContadorPolling(() => ahora);
      contador.registrar();
      ahora = 3_600_000;
      contador.registrar();
      assert.equal(contador.contar(3600), 2);
      ahora += 1;
      contador.purgar();
      assert.equal(contador.contar(3600), 1);
      ahora += 1000;
      assert.equal(contador.contar(1), 0);
    });

    test('durante la carga de grilla, el cambio posterior a la foto se entrega después de estado_completo', { timeout: 8000 }, async (t) => {
      const fotoLista = barrera();
      const soltarFoto = barrera();
      despuesDeGrilla = () => { fotoLista.liberar(); return soltarFoto.espera; };
      t.after(() => { despuesDeGrilla = null; soltarFoto.liberar(); });
      const cliente = conectar(t);
      await fotoLista.espera;
      const a = await bloquear(fixtures[4]);
      assert.equal(cliente.mensajes.length, 0);
      soltarFoto.liberar();

      const snapshot = await recibir(cliente, 'estado_completo');
      const cambio = await recibir(cliente, 'asiento_bloqueado', a.id);
      assert.equal(snapshot.grilla.asientos.find((s) => s.id === a.id).version, a.version - 1);
      assert.deepEqual(cliente.mensajes.slice(0, 2), [snapshot, cambio]);
      assert.deepEqual(cambio, mensajeCambio('asiento_bloqueado', a, { bloqueadoHasta: a.bloqueadoHasta }));
      await liberar(a.id);
    });

    test('si la foto ya incluye un cambio encolado, el servidor conserva una sola versión', { timeout: 8000 }, async (t) => {
      const consultaPendiente = barrera();
      const permitirConsulta = barrera();
      antesDeGrilla = () => { consultaPendiente.liberar(); return permitirConsulta.espera; };
      t.after(() => { antesDeGrilla = null; permitirConsulta.liberar(); });
      const cliente = conectar(t);
      await consultaPendiente.espera;
      const a = await bloquear(fixtures[5]);
      permitirConsulta.liberar();
      const snapshot = await recibir(cliente, 'estado_completo');
      assert.deepEqual(snapshot.grilla.asientos.find((s) => s.id === a.id), a);
      await esperar(140);
      assert.equal(cliente.mensajes.some((m) => m.asientoId === a.id && m.version === a.version), false);
      await liberar(a.id);
    });

    test('un aviso con la fila de una transición posterior fuerza resincronización', async (t) => {
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const id = fixtures[6];
      const inicial = await json(rutaAsiento(id));
      pausarCambios = true;
      let actual;
      try {
        const bloqueado = await bloquear(id);
        assert.equal(bloqueado.version, inicial.version + 1);
        await liberar(id);
        actual = await json(rutaAsiento(id));
      } finally {
        pausarCambios = false;
      }
      assert.equal(actual.version, inicial.version + 2);
      assert.equal(actual.estado, 'libre');

      // Simula el aviso del bloqueo si su lectura poscommit alcanza a ver la liberación.
      const cierre = once(cliente.ws, 'close', { signal: AbortSignal.timeout(5000) });
      entregarCambio(mensajeCambio('asiento_bloqueado', actual, { funcionId, bloqueadoHasta: actual.bloqueadoHasta }));
      assert.equal((await cierre)[0], 1011);
      assert.equal(cliente.mensajes.some((m) => m.asientoId === id), false);
      assert.ok(logs.some((linea) => JSON.parse(linea).evento === 'ws_cambio_no_verificado'));
      const nueva = await recibir(conectar(t), 'estado_completo');
      assert.deepEqual(nueva.grilla.asientos.find((s) => s.id === id), actual);
    });

    test('el apagado ordenado cierra los sockets con 1000', async (t) => {
      const cliente = conectar(t);
      await recibir(cliente, 'estado_completo');
      const cierre = once(cliente.ws, 'close', { signal: AbortSignal.timeout(5000) });
      await servicio.cerrar();
      assert.equal((await cierre)[0], 1000);
    });
  }
}
