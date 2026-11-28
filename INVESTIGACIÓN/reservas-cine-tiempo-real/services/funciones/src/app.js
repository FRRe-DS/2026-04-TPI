require('dotenv').config({ quiet: true });
const express = require('express');
const auth = require('./auth');
const pool = require('./db');

const app = express();
app.use(express.json());

const error = (res, status, codigo, mensaje) => res.status(status).json({ codigo, mensaje });

const aFuncion = (r) => ({
  id: r.id,
  pelicula: r.pelicula,
  sala: r.sala,
  horario: r.horario.toISOString(),
  filas: r.filas,
  asientosPorFila: r.asientos_por_fila,
});

app.get('/api/funciones/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok' });
  } catch {
    error(res, 503, 'SERVICIO_NO_DISPONIBLE', 'Sin conexión a la base de datos.');
  }
});

// Lista las funciones; se puede filtrar por parte del título de la película.
app.get('/api/funciones', auth, async (req, res) => {
  const pelicula = typeof req.query.pelicula === 'string' ? req.query.pelicula.trim() : '';
  const [filas] = pelicula
    ? await pool.execute('SELECT * FROM funciones WHERE pelicula LIKE ? ORDER BY horario', [`%${pelicula}%`])
    : await pool.execute('SELECT * FROM funciones ORDER BY horario');
  res.json(filas.map(aFuncion));
});

app.get('/api/funciones/:funcionId', auth, async (req, res) => {
  const id = Number(req.params.funcionId);
  if (!Number.isInteger(id) || id < 1) return error(res, 400, 'SOLICITUD_INVALIDA', 'funcionId inválido.');
  const [filas] = await pool.execute('SELECT * FROM funciones WHERE id = ?', [id]);
  if (filas.length === 0) return error(res, 404, 'NO_ENCONTRADO', 'No existe la función solicitada.');
  res.json(aFuncion(filas[0]));
});

app.use((req, res) => error(res, 404, 'NO_ENCONTRADO', 'Ruta inexistente.'));

app.use((err, req, res, next) => {
  console.error(err);
  const sinBase = ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);
  if (sinBase) return error(res, 503, 'SERVICIO_NO_DISPONIBLE', 'Sin conexión a la base de datos.');
  error(res, 500, 'ERROR_INTERNO', 'Error interno del servidor.');
});

module.exports = app;
