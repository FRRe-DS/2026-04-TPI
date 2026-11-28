// Tests de la API REST contra la base real. Usa el asiento F6 de la función 42.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba';
const pool = require('../src/db');
const app = require('../src/app');
const eventos = require('../src/eventos');

let server, base, id;
const token = (usuario) => jwt.sign({ sub: usuario }, process.env.JWT_SECRET);
const pedir = (metodo, ruta, usuario) => fetch(base + ruta, {
  method: metodo,
  headers: usuario ? { Authorization: `Bearer ${token(usuario)}` } : {},
});

before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const [[a]] = await pool.execute(
    "SELECT id FROM asientos WHERE funcion_id = 42 AND fila = 'F' AND numero = 6");
  id = a.id;
});
const resetear = () => pool.execute(
  "UPDATE asientos SET estado='libre', bloqueado_por=NULL, bloqueado_hasta=NULL WHERE id = ?", [id]);
beforeEach(resetear);
after(async () => { await resetear(); server.close(); await pool.end(); });

test('sin token devuelve 401', async () => {
  assert.equal((await pedir('GET', '/api/asientos?funcionId=42')).status, 401);
  assert.equal((await pedir('POST', `/api/asientos/${id}/bloqueo`)).status, 401);
});

test('GET /api/asientos devuelve la grilla completa', async () => {
  const res = await pedir('GET', '/api/asientos?funcionId=42', 'ana');
  assert.equal(res.status, 200);
  const grilla = await res.json();
  assert.equal(grilla.funcionId, 42);
  assert.equal(grilla.asientos.length, 96);
});

test('GET /api/asientos valida parámetros y existencia', async () => {
  assert.equal((await pedir('GET', '/api/asientos', 'ana')).status, 400);
  assert.equal((await pedir('GET', '/api/asientos?funcionId=999', 'ana')).status, 404);
});

test('bloquear: 200 al primero, 409 al segundo, y publica un evento', async () => {
  const recibidos = [];
  const escuchar = (m) => recibidos.push(m);
  eventos.on('cambio', escuchar);

  const r1 = await pedir('POST', `/api/asientos/${id}/bloqueo`, 'ana');
  assert.equal(r1.status, 200);
  const a = await r1.json();
  assert.equal(a.estado, 'bloqueado');
  assert.equal(a.bloqueadoPor, 'ana');

  const r2 = await pedir('POST', `/api/asientos/${id}/bloqueo`, 'beto');
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).codigo, 'ASIENTO_NO_DISPONIBLE');

  eventos.off('cambio', escuchar);
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].tipo, 'asiento_bloqueado');
  assert.equal(recibidos[0].funcionId, 42);
});

test('bloquear un asiento inexistente da 404', async () => {
  assert.equal((await pedir('POST', '/api/asientos/99999999/bloqueo', 'ana')).status, 404);
});

test('liberar: 403 si es ajeno, 204 si es propio', async () => {
  await pedir('POST', `/api/asientos/${id}/bloqueo`, 'ana');
  assert.equal((await pedir('DELETE', `/api/asientos/${id}/bloqueo`, 'beto')).status, 403);
  assert.equal((await pedir('DELETE', `/api/asientos/${id}/bloqueo`, 'ana')).status, 204);
  assert.equal((await (await pedir('GET', `/api/asientos/${id}`, 'ana')).json()).estado, 'libre');
});

test('confirmar: 200 al dueño, y después el asiento queda vendido', async () => {
  await pedir('POST', `/api/asientos/${id}/bloqueo`, 'ana');
  assert.equal((await pedir('POST', `/api/asientos/${id}/confirmacion`, 'beto')).status, 403);
  const ok = await pedir('POST', `/api/asientos/${id}/confirmacion`, 'ana');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).estado, 'vendido');
  assert.equal((await pedir('POST', `/api/asientos/${id}/bloqueo`, 'beto')).status, 409);
});

test('confirmar con el bloqueo vencido da 409', async () => {
  await pedir('POST', `/api/asientos/${id}/bloqueo`, 'ana');
  await pool.execute('UPDATE asientos SET bloqueado_hasta = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [id]);
  const res = await pedir('POST', `/api/asientos/${id}/confirmacion`, 'ana');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).codigo, 'BLOQUEO_VENCIDO');
});

test('health responde sin token', async () => {
  const res = await pedir('GET', '/api/asientos/health');
  assert.equal(res.status, 200);
});
