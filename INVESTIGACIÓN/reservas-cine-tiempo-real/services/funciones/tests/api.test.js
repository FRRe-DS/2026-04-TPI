// Tests de la API de Funciones contra la base real (necesita: npm run db:init).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba';
const pool = require('../src/db');
const app = require('../src/app');

let server, base;
const pedir = (ruta, conToken = true) => fetch(base + ruta, {
  headers: conToken ? { Authorization: `Bearer ${jwt.sign({ sub: 'ana' }, process.env.JWT_SECRET)}` } : {},
});

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('sin token devuelve 401', async () => {
  assert.equal((await pedir('/api/funciones', false)).status, 401);
});

test('lista las funciones con el formato del contrato', async () => {
  const res = await pedir('/api/funciones');
  assert.equal(res.status, 200);
  const lista = await res.json();
  assert.equal(lista.length, 3);
  assert.deepEqual(Object.keys(lista[0]).sort(), ['asientosPorFila', 'filas', 'horario', 'id', 'pelicula', 'sala']);
});

test('filtra por película', async () => {
  const lista = await (await pedir('/api/funciones?pelicula=matr')).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, 42);
});

test('obtiene una función y da 404 si no existe', async () => {
  assert.equal((await (await pedir('/api/funciones/42')).json()).pelicula, 'Matrix');
  assert.equal((await pedir('/api/funciones/999')).status, 404);
  assert.equal((await pedir('/api/funciones/abc')).status, 400);
});

test('health responde sin token', async () => {
  assert.equal((await pedir('/api/funciones/health', false)).status, 200);
});
