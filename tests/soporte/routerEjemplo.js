// El endpoint POST /ofertas/:ofertaId/respuesta es el real de src/respuesta/rutas.js.
// Este archivo solo lo reexporta para los tests de seguridad (antes tenía una copia simplificada
// que no implementaba el rechazo y no seguía el contrato con M3).
module.exports = { crearRouterRespuesta: require("../../src/respuesta").crearRouterRespuesta };
