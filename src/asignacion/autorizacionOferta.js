// Regla: el conductor del token debe ser el dueño de la oferta (RNF-12).
//
// El token de M1 trae `identidad_id`, no `conductor_id`, así que hace falta una función
// que traduzca. Es intercambiable:
//  - resolverPorClaim: si M1 incluye el conductor_id en el token.
//  - (a futuro) una que consulte a M3 por identidad_id.
const { errores } = require("../comun/errores");

const resolverPorClaim = async (identidad) => identidad.conductorId;

async function verificarConductorDeOferta({ identidad, oferta, resolverConductorId = resolverPorClaim }) {
  if (!identidad) throw errores.noAutenticado();
  const conductorId = await resolverConductorId(identidad);
  if (!conductorId || conductorId !== oferta.conductorId) {
    throw errores.prohibido("La oferta no corresponde a este conductor");
  }
  return conductorId;
}

module.exports = { verificarConductorDeOferta, resolverPorClaim };
