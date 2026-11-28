const { STATUS_CODES } = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

function enteroPositivo(valor, predeterminado) {
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 && numero <= 2_147_483_647 ? numero : predeterminado;
}

function responderHTTP(socket, estado, codigo, mensaje) {
  if (socket.destroyed) return;
  const cuerpo = JSON.stringify({ codigo, mensaje });
  socket.end([
    `HTTP/1.1 ${estado} ${STATUS_CODES[estado]}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(cuerpo)}`,
    '', cuerpo,
  ].join('\r\n'));
}

function iniciarTiempoReal({ servidor, suscribirCambios, proveedorGrilla, validarToken, verificarCambio, metricas, log }) {
  const salas = new Map();
  const actualizacionesPendientes = new Set();
  const intervaloPing = enteroPositivo(process.env.WS_PING_INTERVAL_MS, 25_000);
  const tiempoGrilla = enteroPositivo(process.env.WS_TIEMPO_GRILLA_MS, 10_000);
  const maxCambiosPendientes = enteroPositivo(process.env.WS_MAX_CAMBIOS_PENDIENTES, 256);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: enteroPositivo(process.env.WS_MAX_PAYLOAD_BYTES, 1024),
    closeTimeout: enteroPositivo(process.env.WS_CIERRE_TIMEOUT_MS, 2_000),
  });

  const registrar = (evento, datos) => log(JSON.stringify({ evento, ...datos }));

  function quitar(conexion, codigo) {
    clearTimeout(conexion.limiteGrilla);
    const sala = salas.get(conexion.funcionId);
    if (!sala?.delete(conexion)) return;
    if (!sala.size) salas.delete(conexion.funcionId);
    registrar('ws_desconexion', { funcionId: conexion.funcionId, codigo });
  }

  function errorInterno(conexion) {
    registrar('ws_error_interno', { funcionId: conexion.funcionId });
    quitar(conexion, 1011);
    conexion.socket.close(1011, 'Error interno');
  }

  function enviar(conexion, carga, contar = true) {
    if (conexion.socket.readyState !== WebSocket.OPEN) return false;
    try {
      conexion.socket.send(carga, (error) => {
        if (error) errorInterno(conexion);
        else if (contar) metricas.registrarMensaje();
      });
      return true;
    } catch {
      errorInterno(conexion);
      return false;
    }
  }

  function versionNueva(conexion, { asientoId, version }) {
    const anterior = conexion.versiones?.get(asientoId);
    return anterior === undefined || version > anterior;
  }

  function enviarCambio(conexion, cambio) {
    if (!versionNueva(conexion, cambio) || !enviar(conexion, cambio.carga)) return false;
    conexion.versiones.set(cambio.asientoId, cambio.version);
    return true;
  }

  function difundir({ funcionId, ...mensaje }) {
    const sala = salas.get(funcionId);
    let destinatarios = 0;
    let encolados = 0;
    if (sala) {
      const cambio = { carga: JSON.stringify(mensaje), asientoId: mensaje.asientoId, version: mensaje.version };
      for (const conexion of sala) {
        if (!conexion.cola) {
          if (enviarCambio(conexion, cambio)) destinatarios += 1;
          continue;
        }
        if (conexion.cola.length >= maxCambiosPendientes) {
          errorInterno(conexion);
          continue;
        }
        conexion.cola.push(cambio);
        encolados += 1;
      }
    }
    registrar('ws_emision', { funcionId, tipo: mensaje.tipo, destinatarios, encolados });
  }

  async function comprobarYDifundir(mensaje) {
    const sala = salas.get(mensaje.funcionId);
    if (!sala?.size) return;
    try {
      const valido = await verificarCambio(mensaje);
      if (salas.get(mensaje.funcionId) !== sala) return;
      if (valido) return difundir(mensaje);
    } catch {
      if (salas.get(mensaje.funcionId) !== sala) return;
    }
    registrar('ws_cambio_no_verificado', { funcionId: mensaje.funcionId, asientoId: mensaje.asientoId });
    for (const conexion of sala) {
      if (versionNueva(conexion, mensaje)) errorInterno(conexion);
    }
  }

  // La verificación asíncrona devuelve el control al emisor del cambio.
  const alCambio = (mensaje) => { void comprobarYDifundir(mensaje); };

  async function aceptar(socket, funcionId) {
    const conexion = { socket, funcionId, cola: [], esperaPong: false };
    if (!salas.has(funcionId)) salas.set(funcionId, new Set());
    salas.get(funcionId).add(conexion);
    socket.once('close', (codigo) => quitar(conexion, codigo));
    socket.on('error', () => {
      if (socket.readyState === WebSocket.OPEN) errorInterno(conexion);
      else quitar(conexion);
    });
    socket.on('message', (datos, binario) => {
      try {
        if (!binario && JSON.parse(datos.toString())?.tipo === 'pong') {
          conexion.esperaPong = false;
          return;
        }
      } catch {
        // El contenido recibido puede contener datos privados. Solo se registra el tipo de rechazo.
      }
      registrar('ws_mensaje_ignorado', { funcionId });
    });
    conexion.limiteGrilla = setTimeout(() => errorInterno(conexion), tiempoGrilla);
    registrar('ws_conexion', { funcionId });

    try {
      const grilla = await proveedorGrilla.obtenerEstadoCompleto(funcionId);
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!grilla) return errorInterno(conexion);

      clearTimeout(conexion.limiteGrilla);
      if (!enviar(conexion, JSON.stringify({ tipo: 'estado_completo', grilla }))) return;

      // Una actualización puede estar ya incorporada en la grilla consultada.
      conexion.versiones = new Map(grilla.asientos.map((asiento) => [asiento.id, asiento.version]));
      for (const cambio of conexion.cola) enviarCambio(conexion, cambio);
      conexion.cola = null;
    } catch {
      if (socket.readyState === WebSocket.OPEN) errorInterno(conexion);
    }
  }

  async function manejarUpgrade(req, socket, head) {
    actualizacionesPendientes.add(socket);
    socket.once('error', () => socket.destroy());
    const limite = setTimeout(() => socket.destroy(), tiempoGrilla);
    try {
      const url = new URL(req.url, 'http://asientos');
      const coincidencia = /^\/ws\/sala\/(\d+)$/.exec(url.pathname);
      const funcionId = Number(coincidencia?.[1]);
      if (!Number.isSafeInteger(funcionId) || funcionId < 1) {
        return responderHTTP(socket, 404, 'NO_ENCONTRADO', 'Ruta o función inexistente.');
      }

      const tokens = url.searchParams.getAll('token');
      if (tokens.length !== 1 || !validarToken(tokens[0])) {
        registrar('ws_autenticacion_rechazada', { funcionId });
        return wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('error', () => ws.terminate());
          ws.close(1008, 'Token ausente o inválido');
        });
      }

      if (!await proveedorGrilla.existeFuncion(funcionId)) {
        return responderHTTP(socket, 404, 'NO_ENCONTRADO', 'No existe la función indicada.');
      }
      if (!socket.destroyed) {
        wss.handleUpgrade(req, socket, head, (ws) => void aceptar(ws, funcionId));
      }
    } catch {
      registrar('ws_error_upgrade');
      responderHTTP(socket, 503, 'SERVICIO_NO_DISPONIBLE', 'No se pudo verificar la función.');
    } finally {
      clearTimeout(limite);
      actualizacionesPendientes.delete(socket);
    }
  }

  servidor.on('upgrade', manejarUpgrade);
  const desuscribirCambios = suscribirCambios(alCambio);

  const latido = setInterval(() => {
    metricas.purgarPolling();
    for (const sala of salas.values()) {
      for (const conexion of sala) {
        if (conexion.cola || conexion.socket.readyState !== WebSocket.OPEN) continue;
        if (conexion.esperaPong) {
          registrar('ws_ping_fallido', { funcionId: conexion.funcionId });
          quitar(conexion, 1006);
          conexion.socket.terminate();
        } else {
          conexion.esperaPong = enviar(conexion, '{"tipo":"ping"}', false);
        }
      }
    }
  }, intervaloPing);
  latido.unref();

  return {
    difundir,
    conexionesPorFuncion() {
      return Object.fromEntries(Array.from(salas, ([funcionId, sala]) => [funcionId, sala.size]));
    },
    cerrar() {
      clearInterval(latido);
      servidor.off('upgrade', manejarUpgrade);
      desuscribirCambios();
      for (const socket of actualizacionesPendientes) socket.destroy();
      for (const ws of wss.clients) ws.close(1000, 'Servidor detenido');
      return new Promise((resolver) => wss.close(resolver));
    },
  };
}

module.exports = { iniciarTiempoReal };
