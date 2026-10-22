// Enumeraciones compartidas de M5 (según el diagrama de clases).
// Viven en `comun` para que A y B usen EXACTAMENTE los mismos valores y nadie
// vuelva a definirlos (ni escriba "pendiente" en minúscula en otro lado).
const EstadoSolicitud = Object.freeze({
  PENDIENTE: "PENDIENTE",
  BUSCANDO: "BUSCANDO",
  ASIGNADA: "ASIGNADA",
  CANCELADA: "CANCELADA",
  SIN_DISPONIBILIDAD: "SIN_DISPONIBILIDAD",
});

const EstadoOferta = Object.freeze({
  PENDIENTE: "PENDIENTE",
  ACEPTADA: "ACEPTADA",
  RECHAZADA: "RECHAZADA",
  VENCIDA: "VENCIDA",
  CANCELADA: "CANCELADA",
});

const EstadoBusqueda = Object.freeze({
  ACTIVA: "ACTIVA",
  AGOTADA: "AGOTADA",
  FINALIZADA: "FINALIZADA",
});

const TipoEvento = Object.freeze({
  BUSQUEDA: "BUSQUEDA",
  OFERTA: "OFERTA",
  RECHAZO: "RECHAZO",
  VENCIMIENTO: "VENCIMIENTO",
  ACEPTACION: "ACEPTACION",
  CANCELACION: "CANCELACION",
});

module.exports = { EstadoSolicitud, EstadoOferta, EstadoBusqueda, TipoEvento };
