// Adaptador de la API de M5 para la implementación G04 (Express).
//
// Traduce cada paso a las rutas y cuerpos de G04 y normaliza las respuestas
// (estados en minúscula). El equivalente de G13 está en su repo, en el mismo lugar.
//
// Variables de entorno:
//   BASE_URL  URL de M5 (por defecto http://127.0.0.1:3001)

import http from 'k6/http';

export const IMPL = 'G04';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

// Parámetros comunes de cada request. `esperados` son los códigos HTTP que ese
// paso espera: así un 409 buscado no cuenta como error en http_req_failed.
function params(nombre, esperados, extra = {}) {
  const p = {
    headers: Object.assign({ 'Content-Type': 'application/json' }, extra),
    tags: { name: nombre, m5_impl: IMPL },
  };
  if (esperados) {
    p.responseCallback = http.expectedStatuses(...esperados);
  }
  return p;
}

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

function cuerpo(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

// ── Salud ───────────────────────────────────────────────────────────────────

export function salud() {
  return http.get(`${BASE_URL}/health`, params('GET /health', [200]));
}

export function listo() {
  return http.get(`${BASE_URL}/health/ready`, params('GET /health/ready', [200]));
}

// ── Pasos del flujo ─────────────────────────────────────────────────────────

// RF-5.1: solicitud inmediata. La identidad del cliente sale del token (sub).
// `token` null = sin Authorization; `idempotencyKey` null = sin el header.
export function crearSolicitud({ token, idempotencyKey, origen, destino, tipoVehiculo }, esperados) {
  const extra = bearer(token);
  if (idempotencyKey) extra['Idempotency-Key'] = idempotencyKey;
  const body = {
    origen_latitud: origen.lat,
    origen_longitud: origen.lon,
    destino_latitud: destino.lat,
    destino_longitud: destino.lon,
    tipo_vehiculo: tipoVehiculo,
  };
  return http.post(`${BASE_URL}/solicitudes`, JSON.stringify(body), params('POST /solicitudes', esperados, extra));
}

export function obtenerSolicitud(solicitudId, token, esperados) {
  return http.get(`${BASE_URL}/solicitudes/${solicitudId}`, params('GET /solicitudes/{id}', esperados, bearer(token)));
}

// Requiere un token de servicio u operador (en el E2E, el de M3). Desde el 27/11 la consulta
// está en /api/v1 (src/respuesta/rutasConsulta.js).
export function listarOfertas(solicitudId, token, esperados) {
  return http.get(
    `${BASE_URL}/api/v1/solicitudes/${solicitudId}/ofertas`,
    params('GET /api/v1/solicitudes/{id}/ofertas', esperados, bearer(token)),
  );
}

// Respuesta de M3 en nombre del conductor (contrato acordado con M3 del consorcio A).
// Devuelve el pedido armado para poder mandar varios a la vez con http.batch.
export function pedidoRespuestaOferta({ ofertaId, conductorId, decision, token }, esperados) {
  return {
    method: 'POST',
    url: `${BASE_URL}/api/v1/offers/${ofertaId}/driver-response`,
    body: JSON.stringify({ driverId: conductorId, decision }),
    params: params('POST /api/v1/offers/{id}/driver-response', esperados, Object.assign(
      { 'Idempotency-Key': crypto.randomUUID() },
      bearer(token),
    )),
  };
}

export function cancelarSolicitud(solicitudId, token, esperados) {
  return http.post(
    `${BASE_URL}/solicitudes/${solicitudId}/cancelar`,
    JSON.stringify({}),
    params('POST /solicitudes/{id}/cancelar', esperados, bearer(token)),
  );
}

// ── Lectura normalizada de respuestas ───────────────────────────────────────

export function campo(res, nombre) {
  const b = cuerpo(res);
  return b && b[nombre] !== undefined && b[nombre] !== null ? b[nombre] : null;
}

export function solicitudId(res) {
  const id = campo(res, 'solicitud_id');
  return id ? String(id) : null;
}

export function estado(res) {
  const e = campo(res, 'estado');
  return e ? String(e).toLowerCase() : null;
}

export function lista(res) {
  const b = cuerpo(res);
  return Array.isArray(b) ? b : null;
}
