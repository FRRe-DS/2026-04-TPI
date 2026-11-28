require('dotenv').config({ quiet: true });
const express = require('express');
const auth = require('./auth');
const eventos = require('./eventos');
const asientos = require('./bloqueo');
const pool = require('./db');

const app = express();
app.use(express.json());

const error = (res, status, codigo, mensaje) => res.status(status).json({ codigo, mensaje });

function idValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const nombre = (a) => `${a.fila}${a.numero}`;

// --- Salud (sin autenticación) ---
app.get('/api/asientos/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok' });
  } catch {
    error(res, 503, 'SERVICIO_NO_DISPONIBLE', 'Sin conexión a la base de datos.');
  }
});

// --- Grilla completa de una función (también la usa el polling) ---
app.get('/api/asientos', auth, async (req, res) => {
  const funcionId = idValido(req.query.funcionId);
  if (!funcionId) {
    return error(res, 400, 'SOLICITUD_INVALIDA', 'El parámetro funcionId es obligatorio y debe ser un entero positivo.');
  }
  const lista = await asientos.obtenerGrilla(funcionId);
  if (lista.length === 0) return error(res, 404, 'NO_ENCONTRADO', 'No existe la función indicada.');
  res.json({ funcionId, generadoEn: new Date().toISOString(), asientos: lista });
});

// --- Un asiento ---
app.get('/api/asientos/:asientoId', auth, async (req, res) => {
  const id = idValido(req.params.asientoId);
  if (!id) return error(res, 400, 'SOLICITUD_INVALIDA', 'asientoId inválido.');
  const a = await asientos.obtenerAsiento(id);
  if (!a) return error(res, 404, 'NO_ENCONTRADO', 'No existe el asiento solicitado.');
  res.json(a);
});

// --- Bloquear ---
app.post('/api/asientos/:asientoId/bloqueo', auth, async (req, res) => {
  const id = idValido(req.params.asientoId);
  if (!id) return error(res, 400, 'SOLICITUD_INVALIDA', 'asientoId inválido.');

  const ganado = await asientos.bloquearAsiento(id, req.usuario);
  const a = await asientos.obtenerAsiento(id);
  if (!a) return error(res, 404, 'NO_ENCONTRADO', 'No existe el asiento solicitado.');

  if (!ganado) {
    const mio = a.estado === 'bloqueado' && a.bloqueadoPor === req.usuario;
    return error(
      res, 409, 'ASIENTO_NO_DISPONIBLE',
      mio ? `Ya tenés bloqueado el asiento ${nombre(a)}.`
          : `El asiento ${nombre(a)} ya fue bloqueado por otra persona o está vendido.`
    );
  }
  eventos.publicar(eventos.mensajes.bloqueado(a));
  res.json(a);
});

// --- Liberar un bloqueo propio ---
app.delete('/api/asientos/:asientoId/bloqueo', auth, async (req, res) => {
  const id = idValido(req.params.asientoId);
  if (!id) return error(res, 400, 'SOLICITUD_INVALIDA', 'asientoId inválido.');

  const liberado = await asientos.liberarAsiento(id, req.usuario);
  const a = await asientos.obtenerAsiento(id);
  if (!a) return error(res, 404, 'NO_ENCONTRADO', 'No existe el asiento solicitado.');

  if (liberado) {
    eventos.publicar(eventos.mensajes.liberado(a, 'liberado_por_usuario'));
    return res.status(204).end();
  }
  if (a.estado === 'libre') return res.status(204).end(); // no había nada que liberar
  if (a.estado === 'vendido') return error(res, 409, 'ASIENTO_VENDIDO', `El asiento ${nombre(a)} ya está vendido.`);
  return error(res, 403, 'BLOQUEO_AJENO', 'No podés liberar un asiento bloqueado por otra persona.');
});

// --- Confirmar la compra ---
app.post('/api/asientos/:asientoId/confirmacion', auth, async (req, res) => {
  const id = idValido(req.params.asientoId);
  if (!id) return error(res, 400, 'SOLICITUD_INVALIDA', 'asientoId inválido.');

  const confirmado = await asientos.confirmarAsiento(id, req.usuario);
  const a = await asientos.obtenerAsiento(id);
  if (!a) return error(res, 404, 'NO_ENCONTRADO', 'No existe el asiento solicitado.');

  if (confirmado) {
    eventos.publicar(eventos.mensajes.vendido(a));
    return res.json(a);
  }
  if (a.estado === 'bloqueado' && a.bloqueadoPor !== req.usuario) {
    return error(res, 403, 'BLOQUEO_AJENO', 'El bloqueo pertenece a otra persona.');
  }
  if (a.estado === 'vendido') return error(res, 409, 'ASIENTO_VENDIDO', `El asiento ${nombre(a)} ya está vendido.`);
  return error(res, 409, 'BLOQUEO_VENCIDO', 'El bloqueo venció o el asiento no está bloqueado. Volvé a elegir el asiento.');
});

// --- Rutas inexistentes y errores ---
app.use((req, res) => error(res, 404, 'NO_ENCONTRADO', 'Ruta inexistente.'));

app.use((err, req, res, next) => {
  console.error(err);
  const sinBase = ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);
  if (sinBase) return error(res, 503, 'SERVICIO_NO_DISPONIBLE', 'Sin conexión a la base de datos.');
  error(res, 500, 'ERROR_INTERNO', 'Error interno del servidor.');
});

module.exports = app;
