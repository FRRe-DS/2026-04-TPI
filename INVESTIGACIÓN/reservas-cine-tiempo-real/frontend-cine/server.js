const express = require('express');
const jwt = require('jsonwebtoken');
const { scrypt, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');

const derivarClave = promisify(scrypt);
const DURACION_SEGUNDOS = 8 * 60 * 60;

// Verificadores de las tres cuentas de demostración. Cada una tiene su propia sal.
const cuentas = new Map([
  ['ana', {
    sal: '299cfb47f1588d14fa9d73378822b6d1',
    hash: '90c518f19e3f657260fb8cdea51ee866d0ceda71ded727f6c1467645275978ab'
  }],
  ['leo', {
    sal: '1520089a84b1ccdf4590728fb189fd16',
    hash: 'b75e7dfa7ebf61b376f77e74f2186e61f4f7f41739bd266f3eab3e13220db945'
  }],
  ['sol', {
    sal: '46b3fbee61da9418ede3ff6b59f19ced',
    hash: '953af58ce7efc4885e3db2054fec050536da38bdf703213419625d37d47d7b42'
  }]
]);

function crearApp(secreto) {
  if (!secreto) throw new Error('Configurá JWT_SECRET con el mismo valor que en Asientos y Funciones.');
  const app = express();
  app.disable('x-powered-by');

  app.post('/sesion', express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { usuario, clave } = req.body || {};
    if (typeof usuario !== 'string' || typeof clave !== 'string' ||
        !usuario.trim() || !clave || usuario.length > 64 || clave.length > 128) {
      return res.status(400).json({ mensaje: 'Completá el usuario y la contraseña.' });
    }
    const nombre = usuario.trim().toLowerCase();
    const cuenta = cuentas.get(nombre);
    // También derivamos una clave para un nombre desconocido.
    const { sal, hash } = cuenta || cuentas.get('ana');
    const esperado = Buffer.from(hash, 'hex');
    const recibido = await derivarClave(clave, Buffer.from(sal, 'hex'), esperado.length);
    if (!timingSafeEqual(recibido, esperado) || !cuenta) {
      return res.status(401).json({ mensaje: 'Usuario o contraseña incorrectos.' });
    }

    const exp = Math.floor(Date.now() / 1000) + DURACION_SEGUNDOS;
    const token = jwt.sign({ sub: nombre, exp }, secreto, { algorithm: 'HS256' });
    return res.json({ usuario: nombre, token, exp });
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    res.set('Cache-Control', 'no-store').status(status).json({
      mensaje: status < 500 ? 'La solicitud no es válida.' : 'No se pudo iniciar sesión.'
    });
  });
  return app;
}

if (require.main === module) {
  crearApp(process.env.JWT_SECRET).listen(3000, () => {
    console.log('Frontend disponible en http://localhost:3000');
  });
}

module.exports = { crearApp };
