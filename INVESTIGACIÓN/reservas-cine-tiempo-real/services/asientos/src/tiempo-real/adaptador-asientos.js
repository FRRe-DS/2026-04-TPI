const jwt = require('jsonwebtoken');

// Único acceso de tiempo real a los módulos existentes de Asientos.
// app.js exporta una app Express montable y carga .env. Su GET de grilla acepta
// funcionId entero positivo y pasa por el middleware que establece req.usuario.
const appAsientos = require('../app');
// auth.js exporta middleware Bearer (req, res, next). Usa HS256, JWT_SECRET y un
// sub no vacío. El upgrade usa las mismas reglas con el token de la consulta.
const autenticarHttp = require('../auth');
// eventos.js expone un EventEmitter. Publica 'cambio' después de escribir, con
// funcionId, asientoId, fila, numero, version y los campos del mensaje OpenAPI.
// mensajes.liberado(asiento, motivo) recibe id, funcionId, fila, numero y version
// del asiento y devuelve el mensaje de liberación con ese motivo.
const eventos = require('../eventos');
// db.js exporta el pool mysql2/promise en UTC. execute(sql, params) devuelve
// [filas, campos] o [resultado, campos]. Los UPDATE usan autocommit y cada
// transición de asientos incrementa version. end() libera el pool del proceso.
const pool = require('../db');
// bloqueo.js exporta obtenerGrilla(funcionId), un array de Asiento. Los
// bloqueos vencidos se leen como libres y una función sin filas se trata como ausente.
const { obtenerGrilla } = require('../bloqueo');

function configuracion() {
  return {
    puerto: Number(process.env.PORT) || 3001,
    intervaloVencimientoMs: Number(process.env.INTERVALO_VENCIMIENTO_MS) || 5000,
    errorInicio: process.env.JWT_SECRET ? null : 'Falta JWT_SECRET en el archivo .env',
  };
}

function montarRest(app, contarSolicitud) {
  app.get('/api/asientos', (req, res, next) => {
    const id = Number(req.query.funcionId);
    if (req.method === 'GET' && Number.isInteger(id) && id > 0) {
      res.once('finish', () => { if (req.usuario) contarSolicitud(); });
    }
    next();
  });
  app.use(appAsientos);
}

function validarToken(token) {
  try {
    return Boolean(jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })?.sub);
  } catch {
    return false;
  }
}

// Entrega cambios con funcionId para el ruteo interno y devuelve la baja del oyente.
// El benchmark puede suscribirse primero para medir antes de la verificación.
function suscribirCambios(oyente, { primero = false } = {}) {
  if (primero) eventos.prependListener('cambio', oyente);
  else eventos.on('cambio', oyente);
  return () => eventos.off('cambio', oyente);
}

async function existeFuncion(funcionId) {
  const [filas] = await pool.execute('SELECT 1 FROM asientos WHERE funcion_id = ? LIMIT 1', [funcionId]);
  return filas.length > 0;
}

async function obtenerEstadoCompleto(funcionId) {
  const lista = await obtenerGrilla(funcionId);
  if (!lista.length) return null;
  const asientos = lista.map((a) => a.estado === 'bloqueado'
    ? a
    : { ...a, bloqueadoPor: null, bloqueadoHasta: null });
  return { funcionId, generadoEn: new Date().toISOString(), asientos };
}

const estados = {
  asiento_bloqueado: 'bloqueado',
  asiento_liberado: 'libre',
  asiento_vendido: 'vendido',
};

// asientos conserva la fila actual, con id como clave, funcion_id y los datos
// públicos del asiento. bloqueado_hasta es Date o null en el pool de Asientos.
// La lectura REST ocurre después de su UPDATE y puede ver una transición posterior.
async function verificarCambio(mensaje) {
  const [[fila]] = await pool.execute(
    'SELECT funcion_id, fila, numero, estado, bloqueado_hasta, version FROM asientos WHERE id = ?',
    [mensaje.asientoId]
  );
  if (!fila || fila.funcion_id !== mensaje.funcionId || fila.fila !== mensaje.fila ||
      fila.numero !== mensaje.numero || fila.version !== mensaje.version ||
      fila.estado !== estados[mensaje.tipo]) return false;
  return mensaje.tipo !== 'asiento_bloqueado' ||
    (fila.bloqueado_hasta !== null && fila.bloqueado_hasta.toISOString() === mensaje.bloqueadoHasta);
}

async function liberarVencidos(emitirCambio) {
  const [vencidos] = await pool.execute(
    "SELECT id, funcion_id, fila, numero, version FROM asientos WHERE estado = 'bloqueado' AND bloqueado_hasta <= NOW()"
  );
  for (const a of vencidos) {
    const [cambio] = await pool.execute(
      `UPDATE asientos
          SET estado = 'libre', bloqueado_por = NULL, bloqueado_hasta = NULL, version = version + 1
        WHERE id = ? AND version = ? AND estado = 'bloqueado' AND bloqueado_hasta <= NOW()`,
      [a.id, a.version]
    );
    if (cambio.affectedRows === 1) {
      const asiento = { id: a.id, funcionId: a.funcion_id, fila: a.fila, numero: a.numero, version: a.version + 1 };
      emitirCambio(eventos.mensajes.liberado(asiento, 'bloqueo_vencido'));
    }
  }
}

module.exports = {
  configuracion, montarRest, autenticarHttp, validarToken, suscribirCambios,
  existeFuncion, obtenerEstadoCompleto, verificarCambio, liberarVencidos,
  cerrarBase: () => pool.end(),
};
