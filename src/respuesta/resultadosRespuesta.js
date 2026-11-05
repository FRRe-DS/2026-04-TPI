// Resultados y traducción a HTTP de la respuesta del conductor a una oferta (RF-5.5).
// Aceptar y rechazar comparten los cinco códigos de src/asignacion/resultados.js; rechazar
// agrega solo el éxito RECHAZADA. "Quiso rechazar lo ya aceptado" es un
// SOLICITUD_NO_DISPONIBLE con motivo YA_ACEPTADA.
// Estas dos funciones cubren AMBOS casos, así el endpoint no necesita saber cuál es cuál.
const { estadoHttp, cuerpoHttp } = require("../asignacion/resultados");

const ResultadoRespuesta = Object.freeze({
  RECHAZADA: "rechazada",
});

function estadoHttpRespuesta(resultado) {
  return resultado === ResultadoRespuesta.RECHAZADA ? 200 : estadoHttp(resultado);
}

function cuerpoHttpRespuesta(r) {
  if (r.resultado === ResultadoRespuesta.RECHAZADA) {
    // No se informa al conductor si la búsqueda se agotó: es un dato interno de la solicitud.
    return { resultado: r.resultado, solicitudId: r.solicitudId, repetida: Boolean(r.repetida) };
  }
  return cuerpoHttp(r);
}

module.exports = { ResultadoRespuesta, estadoHttpRespuesta, cuerpoHttpRespuesta };
