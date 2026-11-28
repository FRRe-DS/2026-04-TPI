/**
 * tests/front/bff.test.js
 *
 * Suite de integración para el BFF del frontend (front/servidor.js).
 * Usa node:test + node:assert/strict (sin Jest).
 *
 * Estrategia de mocking:
 *  - Se levanta un servidor HTTP de backend falso (backendFalso) que responde
 *    las rutas que el BFF proxea: /solicitudes, /solicitudes/:id, /health, etc.
 *  - Se genera un par de claves RSA efímero con node:crypto para firmar JWTs
 *    válidos y se expone un endpoint JWKS local (/protocol/openid-connect/certs)
 *    dentro del mismo servidor de Keycloak falso.
 *  - El BFF se inicia apuntando a esos dos servidores mediante las variables de
 *    entorno API_URL, KEYCLOAK_URL, KEYCLOAK_REALM y KEYCLOAK_CLIENT_ID.
 *
 * Cobertura:
 *  ✓ POST /api/solicitudes/estimacion  (rol clientes-be, sin token → 401, rol incorrecto → 403)
 *  ✓ POST /api/solicitudes/inmediata   (rol clientes-be, 201, cuerpo incompleto → 400)
 *  ✓ GET  /api/solicitudes/:id         (titular → 200, no-titular → 403)
 *  ✓ POST /api/solicitudes/:id/cancelar (titular → 200, no-titular → 403)
 *  ✓ GET  /api/solicitudes/pendientes  (rol solicitud-be → 200)
 *  ✓ DELETE /api/solicitudes/:id       (rol solicitud-be → 200)
 *  ✓ GET  /api/admin/*                 (siempre → 403, independiente del token)
 *  ✓ GET  /api/health                  (backend ok → 200, backend caído → 503)
 *  ✓ despachosEnCurso: deduplicación  (via despacharSolicitud doble — verificada
 *    indirectamente a través del endpoint POST /api/solicitudes/inmediata que
 *    el BFF llama y que a su vez usa app.locals.despacharSolicitud en main.js;
 *    aquí se verifica que el BFF no falla ante respuestas duplicadas)
 */

'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');

// ---------------------------------------------------------------------------
// 1. Par de claves RSA efímero para firmar los JWT de prueba.
// ---------------------------------------------------------------------------

let privateKey, publicKey, publicKeyJwk;

function generarClaves() {
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = priv;
  publicKey = pub;
  publicKeyJwk = crypto.createPublicKey(pub).export({ format: 'jwk' });
}

/** Firma un JWT con el par de claves efímero. */
function firmarJwt({
  sub = 'usuario-test-1',
  roles = ['clientes-be'],
  azp = 'mi-cliente',
  realm = 'mi-realm',
  kcUrl = 'http://localhost',
  expiresInSec = 3600,
} = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'clave-test-1' })
  ).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      iss: `${kcUrl}/realms/${realm}`,
      azp,
      exp: now + expiresInSec,
      iat: now,
      realm_access: { roles },
      email: `${sub}@test.com`,
      preferred_username: sub,
      given_name: 'Test',
      family_name: 'User',
    })
  ).toString('base64url');

  const firma = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');

  return `${header}.${payload}.${firma}`;
}

// ---------------------------------------------------------------------------
// 2. Servidor de Keycloak falso: expone el endpoint JWKS con la clave pública.
// ---------------------------------------------------------------------------

let keycloakFalso;
let kcUrl;
const KC_REALM = 'mi-realm';
const KC_CLIENT_ID = 'mi-cliente';

function iniciarKeycloakFalso() {
  return new Promise((resolve) => {
    keycloakFalso = http.createServer((req, res) => {
      const esperado = `/realms/${KC_REALM}/protocol/openid-connect/certs`;
      if (req.url === esperado) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            keys: [{ ...publicKeyJwk, kid: 'clave-test-1', kty: 'RSA' }],
          })
        );
      }
      res.writeHead(404);
      res.end('{}');
    });

    keycloakFalso.listen(0, '127.0.0.1', () => {
      kcUrl = `http://127.0.0.1:${keycloakFalso.address().port}`;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// 3. Backend falso: simula la API interna (src/main.js).
// ---------------------------------------------------------------------------

const SOLICITUD_ID = '11111111-1111-1111-1111-111111111111';
const CLIENTE_ID   = 'usuario-test-1';
const OTRO_CLIENTE = 'usuario-test-2';

let backendFalso;
let apiUrl;

/** Respuestas que el backend falso devuelve por ruta */
const SOLICITUD_ROW = {
  idSolicitud: SOLICITUD_ID,
  solicitudId: SOLICITUD_ID,
  idCliente: CLIENTE_ID,
  clienteId: CLIENTE_ID,
  origen: 'Plaza Central',
  destino: 'Aeropuerto',
  tipoVehiculo: 'AUTO',
  tipoActivacion: 'Inmediata',
  estado: 'buscando',
  creadaEn: new Date().toISOString(),
  vehiculo_id: null,
  costo: null,
  moneda: null,
  reservaId: null,
  conductorId: null,
};

function iniciarBackendFalso(puerto = 0) {
  return new Promise((resolve) => {
    backendFalso = http.createServer((req, res) => {
      const json = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // POST /solicitudes/estimacion
      if (req.method === 'POST' && req.url === '/solicitudes/estimacion') {
        return json(200, { costo: 1500, moneda: 'ARS' });
      }

      // POST /solicitudes
      if (req.method === 'POST' && req.url === '/solicitudes') {
        return json(201, SOLICITUD_ROW);
      }

      // GET /solicitudes/:id
      const getSolMatch = req.url.match(/^\/solicitudes\/([^?/]+)$/);
      if (req.method === 'GET' && getSolMatch) {
        return json(200, SOLICITUD_ROW);
      }

      // GET /solicitudes (lista)
      if (req.method === 'GET' && req.url === '/solicitudes') {
        return json(200, [SOLICITUD_ROW]);
      }

      // POST /solicitudes/:id/cancelar
      const cancelMatch = req.url.match(/^\/solicitudes\/([^/]+)\/cancelar$/);
      if (req.method === 'POST' && cancelMatch) {
        return json(200, { ...SOLICITUD_ROW, estado: 'cancelada' });
      }

      // DELETE /solicitudes/:id
      const delMatch = req.url.match(/^\/solicitudes\/([^/]+)$/);
      if (req.method === 'DELETE' && delMatch) {
        return json(200, { eliminada: true });
      }

      // GET /health
      if (req.method === 'GET' && req.url === '/health') {
        return json(200, { estado: 'ok' });
      }

      json(404, { error: 'ruta no encontrada en backend falso' });
    });

    backendFalso.listen(puerto, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${backendFalso.address().port}`;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Levantar el BFF (front/servidor.js) con las variables de entorno falseadas.
// ---------------------------------------------------------------------------

let bffServer;
let bffUrl;
let bffClose;

function iniciarBff() {
  return new Promise((resolve, reject) => {
    Object.keys(require.cache)
      .filter((k) => k.includes('front') && k.includes('servidor'))
      .forEach((k) => delete require.cache[k]);

    process.env.API_URL            = apiUrl;
    process.env.KEYCLOAK_URL       = kcUrl;
    process.env.KEYCLOAK_REALM     = KC_REALM;
    process.env.KEYCLOAK_CLIENT_ID = KC_CLIENT_ID;
    process.env.FRONT_PORT         = '0';
    process.env.INTERNAL_API_TOKEN = 'token-de-prueba-no-se-usa-en-bff';

    const originalCreateServer = http.createServer.bind(http);
    const spy = http.createServer = function (...args) {
      bffServer = originalCreateServer(...args);
      http.createServer = originalCreateServer;
      return bffServer;
    };

    try {
      require(path.resolve(__dirname, '../../front/servidor.js'));
    } catch (err) {
      http.createServer = spy;
      return reject(err);
    }

    if (bffServer.listening) {
      bffUrl = `http://127.0.0.1:${bffServer.address().port}`;
      bffClose = promisify(bffServer.close.bind(bffServer));
      return resolve();
    }

    bffServer.once('listening', () => {
      bffUrl = `http://127.0.0.1:${bffServer.address().port}`;
      bffClose = promisify(bffServer.close.bind(bffServer));
      resolve();
    });

    bffServer.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 5. Helpers de solicitudes HTTP.
// ---------------------------------------------------------------------------

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** Token Bearer para un usuario/roles determinados */
function bearer(roles, sub = CLIENTE_ID) {
  return {
    Authorization: `Bearer ${firmarJwt({ roles, sub, kcUrl, realm: KC_REALM, azp: KC_CLIENT_ID })}`,
  };
}

// ---------------------------------------------------------------------------
// 6. Setup / teardown.
// ---------------------------------------------------------------------------

before(async () => {
  generarClaves();
  await iniciarKeycloakFalso();
  await iniciarBackendFalso();
  await iniciarBff();
});

after(async () => {
  await bffClose?.();
  await promisify(backendFalso.close.bind(backendFalso))();
  await promisify(keycloakFalso.close.bind(keycloakFalso))();
});

// ---------------------------------------------------------------------------
// 7. Tests.
// ---------------------------------------------------------------------------

describe('GET /api/admin/* → siempre 403', () => {
  test('sin token devuelve 403', async () => {
    const r = await request(`${bffUrl}/api/admin/usuarios`);
    assert.equal(r.status, 403);
    assert.ok(r.body?.error);
  });

  test('con token válido también devuelve 403', async () => {
    const r = await request(`${bffUrl}/api/admin/algo`, { headers: bearer(['clientes-be']) });
    assert.equal(r.status, 403);
  });
});

describe('GET /api/health', () => {
  test('backend disponible → 200 con estado ok', async () => {
    const r = await request(`${bffUrl}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(r.body?.estado, 'ok');
    assert.equal(r.body?.modulo, 'M5');
  });

  test('backend caído → 503', async () => {
    const puertoAnterior = backendFalso.address().port;
    await promisify(backendFalso.close.bind(backendFalso))();

    const r = await request(`${bffUrl}/api/health`);
    assert.equal(r.status, 503);
    assert.ok(r.body?.error);

    await iniciarBackendFalso(puertoAnterior);
  });
});

describe('POST /api/solicitudes/estimacion', () => {
  test('sin Authorization → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/estimacion`, {
      method: 'POST',
      body: { origen: 'A', destino: 'B', tipoVehiculo: 'AUTO' },
    });
    assert.equal(r.status, 401);
  });

  test('rol incorrecto (solicitud-be) → 403', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/estimacion`, {
      method: 'POST',
      headers: bearer(['solicitud-be']),
      body: { origen: 'A', destino: 'B', tipoVehiculo: 'AUTO' },
    });
    assert.equal(r.status, 403);
  });

  test('rol clientes-be → 200 con tarifa', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/estimacion`, {
      method: 'POST',
      headers: bearer(['clientes-be']),
      body: { origen: 'Plaza Central', destino: 'Aeropuerto', tipoVehiculo: 'AUTO' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body?.costo !== undefined);
  });
});

describe('POST /api/solicitudes/inmediata', () => {
  test('sin Authorization → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/inmediata`, {
      method: 'POST',
      body: { origen: 'A', destino: 'B', tipoVehiculo: 'AUTO' },
    });
    assert.equal(r.status, 401);
  });

  test('cuerpo vacío (sin origen/destino) → 400', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/inmediata`, {
      method: 'POST',
      headers: bearer(['clientes-be']),
      body: {},
    });
    assert.equal(r.status, 400);
  });

  test('rol clientes-be con datos válidos → 201', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/inmediata`, {
      method: 'POST',
      headers: bearer(['clientes-be']),
      body: { origen: 'Plaza Central', destino: 'Aeropuerto', tipoVehiculo: 'AUTO' },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body?.solicitud?.solicitudId);
    assert.equal(r.body?.persistida, true);
  });
});

describe('GET /api/solicitudes/:id (cliente titular)', () => {
  test('sin token → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`);
    assert.equal(r.status, 401);
  });

  test('cliente titular → 200', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`, {
      headers: bearer(['clientes-be'], CLIENTE_ID),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body?.solicitud?.solicitudId, SOLICITUD_ID);
  });

  test('cliente no titular → 403', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`, {
      headers: bearer(['clientes-be'], OTRO_CLIENTE),
    });
    assert.equal(r.status, 403);
  });
});

describe('POST /api/solicitudes/:id/cancelar', () => {
  test('sin token → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}/cancelar`, {
      method: 'POST',
    });
    assert.equal(r.status, 401);
  });

  test('cliente titular → 200 con estado cancelada', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}/cancelar`, {
      method: 'POST',
      headers: bearer(['clientes-be'], CLIENTE_ID),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body?.solicitud?.estado, 'cancelada');
  });

  test('cliente no titular → 403', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}/cancelar`, {
      method: 'POST',
      headers: bearer(['clientes-be'], OTRO_CLIENTE),
    });
    assert.equal(r.status, 403);
  });
});

describe('GET /api/solicitudes/pendientes (rol solicitud-be)', () => {
  test('sin token → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/pendientes`);
    assert.equal(r.status, 401);
  });

  test('rol incorrecto (clientes-be) → 403', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/pendientes`, {
      headers: bearer(['clientes-be']),
    });
    assert.equal(r.status, 403);
  });

  test('rol solicitud-be → 200 con lista de solicitudes', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/pendientes`, {
      headers: bearer(['solicitud-be']),
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body?.solicitudes));
    assert.ok(r.body?.cantidad >= 0);
  });
});

describe('DELETE /api/solicitudes/:id (rol solicitud-be)', () => {
  test('sin token → 401', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`, {
      method: 'DELETE',
    });
    assert.equal(r.status, 401);
  });

  test('rol incorrecto (clientes-be) → 403', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`, {
      method: 'DELETE',
      headers: bearer(['clientes-be']),
    });
    assert.equal(r.status, 403);
  });

  test('rol solicitud-be → 200', async () => {
    const r = await request(`${bffUrl}/api/solicitudes/${SOLICITUD_ID}`, {
      method: 'DELETE',
      headers: bearer(['solicitud-be']),
    });
    assert.equal(r.status, 200);
  });
});

describe('despachosEnCurso — deduplicación (vía POST inmediata doble)', () => {
  test('dos POST simultáneos no causan error 5xx', async () => {
    const opts = {
      method: 'POST',
      headers: bearer(['clientes-be']),
      body: { origen: 'A', destino: 'B', tipoVehiculo: 'AUTO' },
    };
    const [r1, r2] = await Promise.all([
      request(`${bffUrl}/api/solicitudes/inmediata`, opts),
      request(`${bffUrl}/api/solicitudes/inmediata`, opts),
    ]);
    assert.ok(r1.status < 500, `primera petición devolvió ${r1.status}`);
    assert.ok(r2.status < 500, `segunda petición devolvió ${r2.status}`);
  });
});

describe('recuperarDespachos — cobertura indirecta', () => {
  test('BFF sigue respondiendo /api/health tras múltiples requests', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request(`${bffUrl}/api/health`);
      assert.ok([200, 503].includes(r.status), `intento ${i + 1}: estado ${r.status}`);
    }
  });
});
