// Tests de la lógica de bloqueo contra la base real (necesita la base cargada: npm run db:init).
// Usa el asiento F5 de la función 42. (api.test.js usa F6, así no se pisan al correr en paralelo.)
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db');
const b = require('../src/bloqueo');

let id;

before(async () => {
  const [[a]] = await pool.execute(
    "SELECT id FROM asientos WHERE funcion_id = 42 AND fila = 'F' AND numero = 5");
  id = a.id;
});

const resetear = () => pool.execute(
  "UPDATE asientos SET estado='libre', bloqueado_por=NULL, bloqueado_hasta=NULL WHERE id = ?", [id]);
const vencerBloqueo = () => pool.execute(
  'UPDATE asientos SET bloqueado_hasta = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [id]);

beforeEach(resetear);
after(async () => { await resetear(); await pool.end(); });

test('bloquear un asiento libre funciona', async () => {
  assert.equal(await b.bloquearAsiento(id, 'ana'), true);
  const a = await b.obtenerAsiento(id);
  assert.equal(a.estado, 'bloqueado');
  assert.equal(a.bloqueadoPor, 'ana');
  assert.ok(a.bloqueadoHasta);
});

test('un asiento ya bloqueado no se puede bloquear de nuevo', async () => {
  await b.bloquearAsiento(id, 'ana');
  assert.equal(await b.bloquearAsiento(id, 'beto'), false);
  assert.equal((await b.obtenerAsiento(id)).bloqueadoPor, 'ana');
});

test('10 bloqueos simultáneos: gana exactamente uno', async () => {
  const resultados = await Promise.all(
    Array.from({ length: 10 }, (_, i) => b.bloquearAsiento(id, `usuario-${i}`))
  );
  assert.equal(resultados.filter(Boolean).length, 1);
});

test('un bloqueo vencido se ve como libre y se puede volver a bloquear', async () => {
  await b.bloquearAsiento(id, 'ana');
  await vencerBloqueo();
  const a = await b.obtenerAsiento(id);
  assert.equal(a.estado, 'libre');
  assert.equal(a.bloqueadoPor, null);
  assert.equal(await b.bloquearAsiento(id, 'beto'), true);
  assert.equal((await b.obtenerAsiento(id)).bloqueadoPor, 'beto');
});

test('liberar: solo el dueño del bloqueo puede', async () => {
  await b.bloquearAsiento(id, 'ana');
  assert.equal(await b.liberarAsiento(id, 'beto'), false);
  assert.equal(await b.liberarAsiento(id, 'ana'), true);
  assert.equal((await b.obtenerAsiento(id)).estado, 'libre');
});

test('confirmar: el dueño con bloqueo vigente compra el asiento', async () => {
  await b.bloquearAsiento(id, 'ana');
  assert.equal(await b.confirmarAsiento(id, 'ana'), true);
  assert.equal((await b.obtenerAsiento(id)).estado, 'vendido');
  assert.equal(await b.bloquearAsiento(id, 'beto'), false); // vendido: nadie lo bloquea
});

test('confirmar falla si el bloqueo es ajeno o está vencido', async () => {
  await b.bloquearAsiento(id, 'ana');
  assert.equal(await b.confirmarAsiento(id, 'beto'), false);
  await vencerBloqueo();
  assert.equal(await b.confirmarAsiento(id, 'ana'), false);
});

test('liberarVencidos libera los bloqueos vencidos y los informa', async () => {
  await b.bloquearAsiento(id, 'ana');
  await vencerBloqueo();
  const liberados = await b.liberarVencidos();
  assert.ok(liberados.some((x) => x.id === id));
  assert.equal((await b.obtenerAsiento(id)).estado, 'libre');
});
