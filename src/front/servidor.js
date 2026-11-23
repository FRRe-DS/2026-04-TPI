// Servidor del frontend M5. La persistencia se realiza en bd/index.js + MySQL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.FRONT_PORT) || 3005;
const API_URL = process.env.API_URL || 'http://localhost:3000';
const FRONT_DIR = __dirname;
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
  if (!response.ok) throw new Error(data.error || `La API respondió HTTP ${response.status}.`);
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

  if (req.method === 'POST' && url.pathname === '/api/solicitudes/inmediata') {
    try {
      const body = await readBody(req);
      if (!body.origen || !body.destino) {
        return json(res, 400, { error: 'Seleccioná un origen y un destino en el mapa.' });
      }
      const row = await apiRequest('/solicitudes', {
        method: 'POST',
        body: JSON.stringify({
          idCliente: String(body.clienteId || '001'),
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
