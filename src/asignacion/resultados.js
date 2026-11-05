// Resultados de aceptar (o rechazar) una oferta, y su traducción a HTTP (RF-5.5 / RF-5.6).
//
// Son CINCO códigos, agrupados por lo que le importa a quien recibe la respuesta:
//   asignada                 200  éxito
//   solicitud_no_disponible  409  la solicitud ya no se puede asignar (detalle en `motivo`)
//   oferta_no_vigente        410  la oferta venció, fue rechazada o cancelada
//   no_encontrado            404  la oferta (o su solicitud) no existe
//   conductor_no_autorizado  403  la oferta es de otro conductor
//
// El detalle de por qué la solicitud no está disponible NO se pierde: viaja en `motivo`
// (ya_asignada = otro conductor ganó, solicitud_cancelada = el cliente canceló, etc.),
// así la app del conductor puede seguir mostrando el mensaje justo.
const ResultadoAsignacion = Object.freeze({
  ASIGNADA: "asignada",
  SOLICITUD_NO_DISPONIBLE: "solicitud_no_disponible",
  OFERTA_NO_VIGENTE: "oferta_no_vigente",
  NO_ENCONTRADO: "no_encontrado",
  CONDUCTOR_NO_AUTORIZADO: "conductor_no_autorizado",
});

// Motivos posibles cuando el resultado es SOLICITUD_NO_DISPONIBLE.
const MotivoNoDisponible = Object.freeze({
  YA_ASIGNADA: "ya_asignada", // conductor contra conductor: otro ganó
  SOLICITUD_CANCELADA: "solicitud_cancelada", // conductor contra cliente: canceló antes
  SOLICITUD_NO_BUSCANDO: "solicitud_no_buscando", // cualquier otro estado que no sea BUSCANDO
  YA_ACEPTADA: "ya_aceptada", // quiso rechazar una oferta que ya había aceptado
});

// Lo que devuelve el puerto `solicitudes.asignar` del equipo A: ahí SÍ queda el detalle
// completo, para que A no tenga que conocer nuestra simplificación.
const ResultadoPuertoAsignacion = Object.freeze({
  ASIGNADA: "asignada",
  YA_ASIGNADA: "ya_asignada",
  SOLICITUD_CANCELADA: "solicitud_cancelada",
  SOLICITUD_NO_BUSCANDO: "solicitud_no_buscando",
  SOLICITUD_INEXISTENTE: "solicitud_inexistente",
});

// Atajo para armar un "no disponible" con su motivo.
function noDisponible(motivo, extra = {}) {
  return { resultado: ResultadoAsignacion.SOLICITUD_NO_DISPONIBLE, motivo, ...extra };
}

// Traduce un código del puerto de A (o de una reversión de transacción) al resultado
// simplificado. Lo que no reconoce pasa tal cual (termina en 500, como siempre).
function traducirResultadoPuerto(codigo) {
  switch (codigo) {
    case ResultadoPuertoAsignacion.YA_ASIGNADA:
    case ResultadoPuertoAsignacion.SOLICITUD_CANCELADA:
    case ResultadoPuertoAsignacion.SOLICITUD_NO_BUSCANDO:
      return noDisponible(codigo);
    case ResultadoPuertoAsignacion.SOLICITUD_INEXISTENTE:
      return { resultado: ResultadoAsignacion.NO_ENCONTRADO };
    default:
      return { resultado: codigo };
  }
}

// Cómo se traduce cada resultado a HTTP en el borde (lo usa el endpoint de respuesta).
const ESTADO_HTTP = Object.freeze({
  [ResultadoAsignacion.ASIGNADA]: 200,
  [ResultadoAsignacion.SOLICITUD_NO_DISPONIBLE]: 409,
  [ResultadoAsignacion.OFERTA_NO_VIGENTE]: 410,
  [ResultadoAsignacion.NO_ENCONTRADO]: 404,
  [ResultadoAsignacion.CONDUCTOR_NO_AUTORIZADO]: 403,
});

// Mensajes: se eligen por motivo si lo hay, y si no por el código.
const MENSAJES = Object.freeze({
  [MotivoNoDisponible.YA_ASIGNADA]: "La solicitud ya fue asignada a otro conductor",
  [MotivoNoDisponible.SOLICITUD_CANCELADA]: "La solicitud fue cancelada por el cliente",
  [MotivoNoDisponible.SOLICITUD_NO_BUSCANDO]: "La solicitud ya no está en búsqueda",
  [MotivoNoDisponible.YA_ACEPTADA]: "La oferta ya fue aceptada y no puede rechazarse",
  [ResultadoAsignacion.SOLICITUD_NO_DISPONIBLE]: "La solicitud ya no está disponible",
  [ResultadoAsignacion.OFERTA_NO_VIGENTE]: "La oferta venció o ya no está vigente",
  [ResultadoAsignacion.NO_ENCONTRADO]: "La oferta no existe",
  [ResultadoAsignacion.CONDUCTOR_NO_AUTORIZADO]: "La oferta no corresponde a este conductor",
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
  const error = { codigo: r.resultado };
  if (r.motivo) error.motivo = r.motivo;
  error.mensaje = MENSAJES[r.motivo] ?? MENSAJES[r.resultado] ?? "Error";
  return { error };
}

module.exports = {
  ResultadoAsignacion,
  MotivoNoDisponible,
  ResultadoPuertoAsignacion,
  ESTADO_HTTP,
  estadoHttp,
  cuerpoHttp,
  noDisponible,
  traducirResultadoPuerto,
};
