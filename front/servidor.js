
// Servidor del frontend M5.
// La persistencia se realiza en bd/index.js + MySQL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.FRONT_PORT) || 3005;
const API_URL = process.env.API_URL || 'http://localhost:3000';
const FRONT_DIR = __dirname;

const KC_URL = (process.env.KEYCLOAK_URL || '').replace(/\/$/, '');
const KC_REALM = process.env.KEYCLOAK_REALM || '';
const KC_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let jwksCache = null;
let jwksCacheUntil = 0;

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 1_000_000) {
      throw new Error('El cuerpo de la solicitud es demasiado grande.');
    }
  }

  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('El cuerpo no contiene JSON válido.');
  }
}

function mapDbToUi(row) {
  return {
    solicitudId: row.solicitudId || row.idSolicitud,
    clienteId: row.clienteId || row.idCliente,
    origen: row.origen,
    destino: row.destino,
    tipoVehiculo: row.tipoVehiculo,
    vehiculo_id: row.vehiculo_id ?? null,
    costo: row.costo ?? null,
    tipoActivacion: row.tipoActivacion,
    reservaId: row.reservaId || null,
    conductorId: row.conductorId || null,
    estado: row.estado,
    creadaEn: row.creadaEn,
    ofertaEnviadaEn: null
  };
}

async function apiRequest(route, options = {}) {
  const response = await fetch(`${API_URL}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: text || `Respuesta no JSON (HTTP ${response.status})`
    };
  }

  if (!response.ok) {
    const error = new Error(
      data.error || `La API respondió HTTP ${response.status}.`
    );

    error.statusCode = response.status;
    throw error;
  }

  return data;
}

function staticFile(res, pathname) {
  const route = pathname === '/'
    ? '/ventana-de-solicitud.html'
    : pathname;

  const file = path.resolve(FRONT_DIR, '.' + route);

  if (
    file !== FRONT_DIR &&
    !file.startsWith(FRONT_DIR + path.sep)
  ) {
    res.writeHead(403);
    return res.end('Acceso denegado');
  }

  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(
        err.code === 'ENOENT' ? 404 : 500,
        { 'Content-Type': 'text/plain; charset=utf-8' }
      );

      return res.end(
        err.code === 'ENOENT'
          ? 'Archivo no encontrado'
          : 'Error al leer archivo'
      );
    }

    res.writeHead(200, {
      'Content-Type':
        MIME[path.extname(file)] || 'application/octet-stream'
    });

    res.end(content);
  });
}

function keycloakConfigured() {
  return Boolean(KC_URL && KC_REALM && KC_CLIENT_ID);
}

// Obtener las claves públicas del Realm.
async function getJwks() {
  if (jwksCache && Date.now() < jwksCacheUntil) {
    return jwksCache;
  }

  const url =
    `${KC_URL}/realms/${encodeURIComponent(KC_REALM)}` +
    '/protocol/openid-connect/certs';

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `No se pudieron obtener las claves públicas de Keycloak (HTTP ${response.status}).`
    );
  }

  jwksCache = await response.json();
  jwksCacheUntil = Date.now() + 5 * 60 * 1000;

  return jwksCache;
}

// Verificar la firma y los datos del JWT.
async function verifyAccessToken(token) {
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('Token JWT inválido.');
  }

  const header = JSON.parse(
    Buffer.from(parts[0], 'base64url').toString('utf8')
  );

  const payload = JSON.parse(
    Buffer.from(parts[1], 'base64url').toString('utf8')
  );

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('El token utiliza un algoritmo o una clave no admitidos.');
  }

  let jwks = await getJwks();

  let jwk = (jwks.keys || []).find(
    key => key.kid === header.kid && key.kty === 'RSA'
  );

  // Actualizar las claves si Keycloak realizó una rotación.
  if (!jwk) {
    jwksCacheUntil = 0;
    jwks = await getJwks();

    jwk = (jwks.keys || []).find(
      key => key.kid === header.kid && key.kty === 'RSA'
    );

    if (!jwk) {
      throw new Error('Keycloak no publicó la clave con la que se firmó el token.');
    }
  }

  return verifyJwtSignatureAndClaims(parts, payload, jwk);
}

function verifyJwtSignatureAndClaims(parts, payload, jwk) {
  const publicKey = crypto.createPublicKey({
    key: jwk,
    format: 'jwk'
  });

  const signedContent = Buffer.from(
    `${parts[0]}.${parts[1]}`
  );

  const signature = Buffer.from(parts[2], 'base64url');

  const validSignature = crypto.verify(
    'RSA-SHA256',
    signedContent,
    publicKey,
    signature
  );

  if (!validSignature) {
    throw new Error('La firma del token no es válida.');
  }

  const expectedIssuer =
    `${KC_URL}/realms/${KC_REALM}`;

  if (payload.iss !== expectedIssuer) {
    throw new Error('El token no pertenece al Realm configurado.');
  }

  if (
    !payload.exp ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('El token venció.');
  }

  if (
    payload.nbf &&
    payload.nbf > Math.floor(Date.now() / 1000)
  ) {
    throw new Error('El token todavía no es válido.');
  }

  if (payload.azp && payload.azp !== KC_CLIENT_ID) {
    throw new Error('El token no fue emitido para el cliente configurado.');
  }

  return payload;
}

// Comprobar que el usuario tenga el rol requerido.
async function requireRole(req, requiredRole) {
  const authorization = req.headers.authorization || '';

  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return { error: 401 };
  }

  if (!keycloakConfigured()) {
    return { error: 503 };
  }

  try {
    const token = await verifyAccessToken(match[1]);

    const roles = token.realm_access?.roles || [];

    if (!roles.includes(requiredRole)) {
      return { error: 403 };
    }

    return {
      roles,
      email: token.email || '',
      username: token.preferred_username || '',
      nombre: [token.given_name, token.family_name].filter(Boolean).join(' ').trim()
    };

  } catch (error) {
    console.error(
      'Error verificando token de Keycloak:',
      error.message
    );

    return { error: 401 };
  }
}

http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // Configuración de autenticación para auth.js.
  if (
    req.method === 'GET' &&
    url.pathname === '/auth-config.json'
  ) {
    return json(res, 200, {
      url: KC_URL,
      realm: KC_REALM,
      clientId: KC_CLIENT_ID
    });
  }

  // La administración de usuarios queda deshabilitada
  // hasta que exista un rol administrador confirmado.
  if (url.pathname.startsWith('/api/admin/')) {
    return json(res, 403, {
      error: 'La administración de usuarios no está habilitada para M5.'
    });
  }

  // CREAR SOLICITUD: rol clientes-be.
  if (
    req.method === 'POST' &&
    url.pathname === '/api/solicitudes/inmediata'
  ) {
    try {
      const auth = await requireRole(req, 'clientes-be');

      if (auth.error) {
        const message = auth.error === 403
          ? 'Se requiere el rol clientes-be.'
          : 'Autenticación requerida o configuración de Keycloak incorrecta.';

        return json(res, auth.error, { error: message });
      }

      if (!auth.email) {
        return json(res, 400, {
          error: 'El usuario autenticado no tiene un email disponible en Keycloak.'
        });
      }

      const body = await readBody(req);

      if (!body.origen || !body.destino) {
        return json(res, 400, {
          error: 'Seleccioná un origen y un destino en el mapa.'
        });
      }

      const row = await apiRequest('/solicitudes', {
        method: 'POST',
        body: JSON.stringify({
          idCliente: auth.email,
          origen: body.origen,
          destino: body.destino,
          tipoVehiculo: body.tipoVehiculo,
          tipoActivacion: body.tipoActivacion || 'Inmediata',
          reservaId: body.reservaId || null
        })
      });

      return json(res, 201, {
        solicitud: { ...mapDbToUi(row), clienteNombre: auth.nombre || auth.username || 'Cliente' },
        persistida: true
      });

    } catch (error) {
      console.error('Error al guardar solicitud:', error);

      return json(res, error.statusCode || 502, {
        error:
          `${error.message} Verificá que la API de bd esté ejecutándose en ${API_URL}.`
      });
    }
  }

  // CANCELAR VIAJE ACTIVO: rol clientes-be.
  const cancelSolicitudMatch = url.pathname.match(/^\/api\/solicitudes\/([^/]+)\/cancelar$/);
  if (req.method === 'PATCH' && cancelSolicitudMatch) {
    try {
      const auth = await requireRole(req, 'clientes-be');
      if (auth.error) return json(res, auth.error, { error: auth.error === 403 ? 'Se requiere el rol clientes-be.' : 'Autenticación requerida o configuración de Keycloak incorrecta.' });
      const solicitudId = decodeURIComponent(cancelSolicitudMatch[1]);
      const solicitudes = await apiRequest('/solicitudes');
      const propia = solicitudes.find(row => (row.solicitudId || row.idSolicitud) === solicitudId);
      if (!propia) return json(res, 404, { error: 'Solicitud no encontrada.' });
      if ((propia.clienteId || propia.idCliente) !== auth.email) return json(res, 403, { error: 'Solo podés cancelar tus propios viajes.' });
      const result = await apiRequest(`/solicitudes/${encodeURIComponent(solicitudId)}/cancelar`, { method: 'PATCH' });
      return json(res, 200, { solicitud: { ...mapDbToUi(result), clienteNombre: auth.nombre || auth.username || 'Cliente' } });
    } catch (error) {
      return json(res, error.statusCode || 502, { error: error.message || 'No se pudo cancelar el viaje.' });
    }
  }

  // CONSULTAR SOLICITUDES: rol solicitud-be.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/solicitudes/pendientes'
  ) {
    try {
      const auth = await requireRole(req, 'solicitud-be');

      if (auth.error) {
        const message = auth.error === 403
          ? 'Se requiere el rol solicitud-be.'
          : 'Autenticación requerida o configuración de Keycloak incorrecta.';

        return json(res, auth.error, { error: message });
      }

      const rows = await apiRequest('/solicitudes');
      const solicitudes = rows.map(mapDbToUi);

      return json(res, 200, {
        cantidad: solicitudes.length,
        solicitudes
      });

    } catch (error) {
      console.error('Error al consultar solicitudes:', error);

      return json(res, error.statusCode || 502, {
        error:
          `${error.message} Verificá que la API de bd esté ejecutándose en ${API_URL}.`
      });
    }
  }

  // ELIMINAR SOLICITUD: rol solicitud-be.
  const deleteSolicitudMatch =
    url.pathname.match(/^\/api\/solicitudes\/([^/]+)$/);

  if (
    req.method === 'DELETE' &&
    deleteSolicitudMatch
  ) {
    try {
      const auth = await requireRole(req, 'solicitud-be');

      if (auth.error) {
        const message = auth.error === 403
          ? 'Se requiere el rol solicitud-be.'
          : 'Autenticación requerida o configuración de Keycloak incorrecta.';

        return json(res, auth.error, { error: message });
      }

      let solicitudId;

      try {
        solicitudId = decodeURIComponent(deleteSolicitudMatch[1]);
      } catch {
        return json(res, 400, {
          error: 'El identificador de la solicitud no es válido.'
        });
      }

      if (!solicitudId) {
        return json(res, 400, {
          error: 'El identificador de la solicitud no es válido.'
        });
      }

      const result = await apiRequest(
        `/solicitudes/${encodeURIComponent(solicitudId)}`,
        { method: 'DELETE' }
      );

      return json(res, 200, result);

    } catch (error) {
      console.error('Error al eliminar solicitud:', error);

      return json(res, error.statusCode || 502, {
        error: error.message || 'No se pudo eliminar la solicitud.'
      });
    }
  }

  // Comprobar conexión con la API de base de datos.
  if (
    req.method === 'GET' &&
    url.pathname === '/api/health'
  ) {
    try {
      const result = await apiRequest('/health');

      return json(res, 200, {
        estado: 'ok',
        modulo: 'M5',
        api: result
      });

    } catch (error) {
      return json(res, 503, {
        estado: 'error',
        error: error.message
      });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return staticFile(res, decodeURIComponent(url.pathname));
  }

  return json(res, 404, {
    error: 'Ruta no encontrada.'
  });

}).listen(PORT, () => {
  console.log(`Frontend M5: http://localhost:${PORT}`);
  console.log(`API configurada: ${API_URL}`);
  console.log(`Keycloak: ${KC_URL}/realms/${KC_REALM} (cliente ${KC_CLIENT_ID})`);
});
