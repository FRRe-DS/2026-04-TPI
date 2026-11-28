const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { crearApp } = require('../server');

const secreto = randomBytes(32).toString('hex');
let servidor;
let url;

before(async () => {
  servidor = crearApp(secreto).listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  url = `http://127.0.0.1:${servidor.address().port}/sesion`;
});
after(async () => {
  if (servidor?.listening) {
    await new Promise((resolve, reject) => servidor.close(err => err ? reject(err) : resolve()));
  }
});

function ingresar(datos) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos)
  });
}

for (const [usuario, clave] of [['ana', 'luna'], ['leo', 'cine'], ['sol', 'sala']]) {
  test(`${usuario} recibe una sesión firmada que dura ocho horas`, async () => {
    const respuesta = await ingresar({ usuario, clave });
    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.headers.get('cache-control'), 'no-store');
    const sesion = await respuesta.json();
    const { sub, iat, exp } = jwt.verify(sesion.token, secreto, { algorithms: ['HS256'] });
    assert.equal(sesion.usuario, usuario);
    assert.equal(sub, usuario);
    assert.equal(sesion.exp, exp);
    assert.equal(exp - iat, 8 * 60 * 60);
  });
}

test('usuario desconocido y clave incorrecta reciben el mismo rechazo', async () => {
  for (const usuario of ['desconocido', 'ana']) {
    const respuesta = await ingresar({ usuario, clave: 'cine' });
    assert.equal(respuesta.status, 401);
    assert.deepEqual(await respuesta.json(), { mensaje: 'Usuario o contraseña incorrectos.' });
  }
});

test('las credenciales incompletas reciben 400', async () => {
  const respuesta = await ingresar({ usuario: 'ana' });
  assert.equal(respuesta.status, 400);
  assert.equal((await respuesta.json()).token, undefined);
});

test('el nombre se normaliza y la identidad sale de la cuenta verificada', async () => {
  const respuesta = await ingresar({ usuario: ' Ana ', clave: 'luna', sub: 'sol' });
  assert.equal(respuesta.status, 200);
  const sesion = await respuesta.json();
  assert.equal(sesion.usuario, 'ana');
  assert.equal(jwt.verify(sesion.token, secreto, { algorithms: ['HS256'] }).sub, 'ana');
});
