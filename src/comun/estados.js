// Enumeraciones compartidas de M5 (según el diagrama de clases).
// Viven en `comun` para que A y B usen EXACTAMENTE los mismos valores y nadie
// vuelva a definirlos. Los valores van en snake_case minúscula (ej.: "sin_disponibilidad").
const EstadoSolicitud = Object.freeze({
  PENDIENTE: "pendiente",
  BUSCANDO: "buscando",
  ASIGNADA: "asignada",
  CANCELADA: "cancelada",
  SIN_DISPONIBILIDAD: "sin_disponibilidad",
});

const EstadoOferta = Object.freeze({
  PENDIENTE: "pendiente",
  ACEPTADA: "aceptada",
  RECHAZADA: "rechazada",
  VENCIDA: "vencida",
  CANCELADA: "cancelada",
});

const EstadoBusqueda = Object.freeze({
  ACTIVA: "activa",
  AGOTADA: "agotada",
  FINALIZADA: "finalizada",
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
