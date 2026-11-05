// Endpoint POST /ofertas/:ofertaId/respuesta (RF-5.5): el conductor acepta o rechaza.
//
// Es un ORQUESTADOR: no decide nada de negocio. Aplica los controles de seguridad en orden y
// llama a procesarAceptacion o procesarRechazo; después traduce el resultado a HTTP.
//
// Orden (cada paso es más caro que el anterior y no se llega al siguiente si falla):
//   1) rol CONDUCTOR            -> 403
//   2) entrada válida           -> 400   (ofertaId UUID y body exactamente { acepta: boolean })
//   3) la oferta existe         -> 404
//   4) el token es de su dueño  -> 403
//   5) aceptar / rechazar       -> 200 / 409 / 410 ...
// Cualquier error inesperado va a next(error): el manejador final responde un 500 genérico.
const express = require("express");
const { ROLES, errores, asociarSolicitud } = require("../comun");
const {
  procesarAceptacion,
  verificarConductorDeOferta,
  esquemaParamsOferta,
  esquemaRespuestaOferta,
} = require("../asignacion");
const { procesarRechazo } = require("./procesarRechazo");
const { estadoHttpRespuesta, cuerpoHttpRespuesta } = require("./resultadosRespuesta");

// `resolverConductorId` es opcional: cómo pasar de la identidad del token al conductorId de la
// oferta (por defecto, el claim configurado en JWT_CLAIM_CONDUCTOR).
function crearRouterRespuesta({ deps, requerirRol, validar, resolverConductorId }) {
  const router = express.Router();

  router.post(
    "/ofertas/:ofertaId/respuesta",
    requerirRol(ROLES.CONDUCTOR),
    validar({ params: esquemaParamsOferta, body: esquemaRespuestaOferta }),
    async (req, res, next) => {
      try {
        const { ofertaId } = req.validado.params;
        const oferta = await deps.ofertas.obtenerPorId(ofertaId);
        if (!oferta) throw errores.noEncontrado("La oferta no existe");

        const conductorId = await verificarConductorDeOferta({
          identidad: req.identidad,
          oferta,
          ...(resolverConductorId ? { resolverConductorId } : {}),
        });
        asociarSolicitud(req, oferta.solicitudId); // los logs de este pedido llevan el solicitudId

        const resultado = req.validado.body.acepta
          ? await procesarAceptacion({ ofertaId, conductorId }, deps)
          : await procesarRechazo({ ofertaId, conductorId }, deps);

        return res.status(estadoHttpRespuesta(resultado.resultado)).json(cuerpoHttpRespuesta(resultado));
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = { crearRouterRespuesta };
