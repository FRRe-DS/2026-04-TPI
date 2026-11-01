// Servidor del frontend M5. La persistencia se realiza en bd/index.js + MySQL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.FRONT_PORT) || 3005;
const API_URL = process.env.API_URL || 'http://localhost:3000';
const FRONT_DIR = __dirname;
const KC_URL = process.env.KEYCLOAK_URL || '';
const KC_REALM = process.env.KEYCLOAK_REALM || '';
const KC_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'm5-web';
const KC_ADMIN_CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID || '';
const KC_ADMIN_CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || '';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

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
    if (body.length > 1_000_000) throw new Error('El cuerpo de la solicitud es demasiado grande.');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('El cuerpo no contiene JSON válido.'); }
}
function mapDbToUi(row) {
  return {
    solicitudId: row.solicitudId || row.idSolicitud,
    clienteId: row.clienteId || row.idCliente,
    origen: row.origen,
    destino: row.destino,
    tipoVehiculo: row.tipoVehiculo,
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
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text || `Respuesta no JSON (HTTP ${response.status})` }; }
  if (!response.ok) {
    const error = new Error(data.error || `La API respondió HTTP ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}
function staticFile(res, pathname) {
  const route = pathname === '/' ? '/ventana-de-solicitud.html' : pathname;
  const file = path.resolve(FRONT_DIR, '.' + route);
  if (file !== FRONT_DIR && !file.startsWith(FRONT_DIR + path.sep)) {
    res.writeHead(403); return res.end('Acceso denegado');
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(err.code === 'ENOENT' ? 'Archivo no encontrado' : 'Error al leer archivo');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/auth-config.json') {
    return json(res, 200, { url: KC_URL, realm: KC_REALM, clientId: KC_CLIENT_ID });
  }

  async function requireRole(role) {
    const bearer = req.headers.authorization || '';
    if (!/^Bearer\s+\S+$/i.test(bearer)) return { error: 401 };
    if (!KC_URL || !KC_REALM || !KC_ADMIN_CLIENT_ID || !KC_ADMIN_CLIENT_SECRET) return { error: 503 };
    const form = new URLSearchParams({
      client_id: KC_ADMIN_CLIENT_ID,
      client_secret: KC_ADMIN_CLIENT_SECRET,
      token: bearer.replace(/^Bearer\s+/i, '')
    });
    const response = await fetch(`${KC_URL}/realms/${encodeURIComponent(KC_REALM)}/protocol/openid-connect/token/introspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    const token = await response.json();
    if (!response.ok || !token.active) return { error: 401 };
    const serviceToken = await adminToken();
    const mappings = await fetch(`${KC_URL}/admin/realms/${encodeURIComponent(KC_REALM)}/users/${encodeURIComponent(token.sub)}/role-mappings/realm/composite`, {
      headers: { Authorization: `Bearer ${serviceToken}` }
    });
    if (!mappings.ok) return { error: 401 };
    const roles = (await mappings.json()).map(item => item.name);
    if (role && !roles.includes(role)) {
      return { error: 403 };
    }

    // Obtener los datos reales del usuario autenticado.
    const userResponse = await fetch(
      `${KC_URL}/admin/realms/${encodeURIComponent(KC_REALM)}/users/${encodeURIComponent(token.sub)}`,
      {
        headers: {
          Authorization: `Bearer ${serviceToken}`
        }
      }
    );

    if (!userResponse.ok) {
      return { error: 401 };
    }

    const user = await userResponse.json();

    if (role === 'cliente' && !user.email) {
      return { error: 400 };
    }

    return {
      roles,
      email: user.email || '',
      username: user.username || ''
    };
  }
  async function adminToken() {
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: KC_ADMIN_CLIENT_ID, client_secret: KC_ADMIN_CLIENT_SECRET });
    const response = await fetch(`${KC_URL}/realms/${encodeURIComponent(KC_REALM)}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error('No se pudo obtener token de administración Keycloak.');
    return data.access_token;
  }
  if (url.pathname.startsWith('/api/admin/')) {
    try {
      const auth = await requireRole('administrador');
      if (auth.error) return json(res, auth.error, { error: auth.error === 403 ? 'Permiso insuficiente.' : 'Autenticación requerida o configuración Keycloak incompleta.' });
      const token = await adminToken();
      const base = `${KC_URL}/admin/realms/${encodeURIComponent(KC_REALM)}`;
      if (req.method === 'GET' && url.pathname === '/api/admin/users') {
        const upstream = await fetch(`${base}/users?max=200&briefRepresentation=false`, { headers: { Authorization: `Bearer ${token}` } });
        const users = await upstream.json();
        if (!upstream.ok) return json(res, upstream.status, users);
        const result = await Promise.all(users.map(async user => {
          const mappings = await fetch(`${base}/users/${encodeURIComponent(user.id)}/role-mappings/realm/composite`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
          const role = (mappings || []).find(item => ['cliente', 'encargado', 'administrador'].includes(item.name))?.name || '';
          return { id: user.id, username: user.username, email: user.email || '', firstName: user.firstName || '', lastName: user.lastName || '', enabled: user.enabled, role };
        }));
        return json(res, 200, result);
      }
      const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
      if (req.method === 'PUT' && match) {
        const body = await readBody(req);
        const allowed = ['cliente', 'encargado', 'administrador'];
        if (!allowed.includes(body.role)) return json(res, 400, { error: 'Rol inválido.' });
        const userId = decodeURIComponent(match[1]);
        const roleRes = await fetch(`${base}/roles/${body.role}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!roleRes.ok) return json(res, roleRes.status, { error: 'No se encontró el rol solicitado en Keycloak.' });
        const role = await roleRes.json();
        const mapped = await fetch(`${base}/users/${encodeURIComponent(userId)}/role-mappings/realm`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([role])
        });
        if (!mapped.ok) return json(res, mapped.status, { error: 'No se pudo asignar el rol.' });
        const allRoles = await fetch(`${base}/roles?briefRepresentation=true`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        const otherRoles = allRoles.filter(item => allowed.includes(item.name) && item.name !== body.role);
        if (otherRoles.length) await fetch(`${base}/users/${encodeURIComponent(userId)}/role-mappings/realm`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(otherRoles)
        });
        return json(res, 200, { actualizado: true, role: body.role });
      }
    } catch (error) {
      console.error('Error en administración Keycloak:', error);
      return json(res, 502, { error: error.message || 'Error al consultar Keycloak.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/solicitudes/inmediata') {
    try {
      const auth = await requireRole('cliente');
      if (auth.error) return json(res, auth.error, { error: 'Se requiere el rol cliente.' });
      const body = await readBody(req);
      if (!body.origen || !body.destino) {
        return json(res, 400, { error: 'Seleccioná un origen y un destino en el mapa.' });
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
      return json(res, 201, { solicitud: mapDbToUi(row), persistida: true });
    } catch (error) {
      console.error('Error al guardar solicitud:', error);
      return json(res, 502, {
        error: `${error.message} Verificá que la API de bd esté ejecutándose en ${API_URL}.`
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/solicitudes/pendientes') {
    try {
      const auth = await requireRole('encargado');
      if (auth.error) return json(res, auth.error, { error: 'Se requiere el rol encargado.' });
      const rows = await apiRequest('/solicitudes');
      const solicitudes = rows.map(mapDbToUi);
      return json(res, 200, {
        cantidad: solicitudes.length,
        solicitudes
      });
    } catch (error) {
      console.error('Error al consultar solicitudes:', error);
      return json(res, 502, {
        error: `${error.message} Verificá que la API de bd esté ejecutándose en ${API_URL}.`
      });
    }
  }

  const deleteSolicitudMatch = url.pathname.match(/^\/api\/solicitudes\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteSolicitudMatch) {
    try {
      const auth = await requireRole('encargado');
      if (auth.error) return json(res, auth.error, { error: 'Se requiere el rol encargado.' });

      let solicitudId;
      try {
        solicitudId = decodeURIComponent(deleteSolicitudMatch[1]);
      } catch {
        return json(res, 400, { error: 'El identificador de la solicitud no es válido.' });
      }

      if (!solicitudId) {
        return json(res, 400, { error: 'El identificador de la solicitud no es válido.' });
      }

      const result = await apiRequest(`/solicitudes/${encodeURIComponent(solicitudId)}`, {
        method: 'DELETE'
      });
      return json(res, 200, result);
    } catch (error) {
      console.error('Error al eliminar solicitud:', error);
      return json(res, error.statusCode || 502, {
        error: error.message || 'No se pudo eliminar la solicitud.'
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    try {
      const result = await apiRequest('/health');
      return json(res, 200, { estado: 'ok', modulo: 'M5', api: result });
    } catch (error) {
      return json(res, 503, { estado: 'error', error: error.message });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return staticFile(res, decodeURIComponent(url.pathname));
  return json(res, 404, { error: 'Ruta no encontrada.' });
}).listen(PORT, () => {
  console.log(`Frontend M5: http://localhost:${PORT}`);
  console.log(`API configurada: ${API_URL}`);
});
