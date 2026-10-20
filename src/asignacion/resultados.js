// Resultados posibles de intentar asignar una solicitud a un conductor (RF-5.6).
// Distinguimos "ya asignada" de "cancelada": son dos carreras distintas
// (conductor contra conductor, y conductor contra cliente que cancela).
const ResultadoAsignacion = Object.freeze({
  ASIGNADA: "ASIGNADA",
  YA_ASIGNADA: "YA_ASIGNADA",
  SOLICITUD_CANCELADA: "SOLICITUD_CANCELADA",
  SOLICITUD_NO_BUSCANDO: "SOLICITUD_NO_BUSCANDO",
  SOLICITUD_INEXISTENTE: "SOLICITUD_INEXISTENTE",
  OFERTA_NO_VIGENTE: "OFERTA_NO_VIGENTE",
  OFERTA_INEXISTENTE: "OFERTA_INEXISTENTE",
  CONDUCTOR_NO_AUTORIZADO: "CONDUCTOR_NO_AUTORIZADO",
});

// Cómo se traduce cada resultado a HTTP en el borde (lo usa el endpoint de respuesta).
const ESTADO_HTTP = Object.freeze({
  ASIGNADA: 200,
  YA_ASIGNADA: 409,
  SOLICITUD_CANCELADA: 409,
  SOLICITUD_NO_BUSCANDO: 409,
  SOLICITUD_INEXISTENTE: 404,
  OFERTA_NO_VIGENTE: 410,
  OFERTA_INEXISTENTE: 404,
  CONDUCTOR_NO_AUTORIZADO: 403,
});

const MENSAJES = Object.freeze({
  YA_ASIGNADA: "La solicitud ya fue asignada a otro conductor",
  SOLICITUD_CANCELADA: "La solicitud fue cancelada por el cliente",
  SOLICITUD_NO_BUSCANDO: "La solicitud ya no está en búsqueda",
  SOLICITUD_INEXISTENTE: "La solicitud no existe",
  OFERTA_NO_VIGENTE: "La oferta venció o ya no está vigente",
  OFERTA_INEXISTENTE: "La oferta no existe",
  CONDUCTOR_NO_AUTORIZADO: "La oferta no corresponde a este conductor",
});

function estadoHttp(resultado) {
  return ESTADO_HTTP[resultado] ?? 500;
}

// Cuerpo de respuesta listo para enviar según el resultado.
function cuerpoHttp(r) {
  if (r.resultado === ResultadoAsignacion.ASIGNADA) {
    return {
      resultado: r.resultado,
      solicitudId: r.solicitudId,
      conductorId: r.conductorId,
      repetida: Boolean(r.repetida),
    };
  }
  return { error: { codigo: r.resultado, mensaje: MENSAJES[r.resultado] ?? "Error" } };
}

module.exports = { ResultadoAsignacion, ESTADO_HTTP, estadoHttp, cuerpoHttp };
