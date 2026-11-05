// Endpoint POST /ofertas/:ofertaId/respuesta (RF-5.5): el conductor acepta o rechaza.
// Cuerpo (contrato con M3): { solicitud_id, oferta_id, conductor_id, respuesta: "aceptado" | "rechazado" }.
//
// Es un ORQUESTADOR: no decide nada de negocio. Aplica los controles de seguridad en orden y
// llama a procesarAceptacion o procesarRechazo; después traduce el resultado a HTTP.
//
// Orden (cada paso es más caro que el anterior y no se llega al siguiente si falla):
//   1) rol CONDUCTOR            -> 403
//   2) entrada válida           -> 400   (ofertaId UUID y body exactamente los cuatro campos del contrato)
//   3) la oferta existe         -> 404
//   4) el token es de su dueño  -> 403
//   5) los ids del body coinciden con la oferta (oferta_id con la ruta y solicitud_id -> 400;
//      conductor_id -> 403). Va DESPUÉS del dueño para no revelar datos de ofertas ajenas.
//   6) aceptar / rechazar       -> 200 / 409 / 410 ...
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
        const cuerpo = req.validado.body;
        const oferta = await deps.ofertas.obtenerPorId(ofertaId);
        if (!oferta) throw errores.noEncontrado("La oferta no existe");

        const conductorId = await verificarConductorDeOferta({
          identidad: req.identidad,
          oferta,
          ...(resolverConductorId ? { resolverConductorId } : {}),
        });
        asociarSolicitud(req, oferta.solicitudId); // los logs de este pedido llevan el solicitudId

        if (cuerpo.conductor_id !== oferta.conductorId) {
          throw errores.prohibido("La oferta no corresponde a este conductor");
        }
        const inconsistencias = [];
        if (cuerpo.oferta_id !== ofertaId) {
          inconsistencias.push({ campo: "body.oferta_id", mensaje: "oferta_id no coincide con la ruta" });
        }
        if (cuerpo.solicitud_id !== oferta.solicitudId) {
          inconsistencias.push({ campo: "body.solicitud_id", mensaje: "solicitud_id no corresponde a la oferta" });
        }
        if (inconsistencias.length > 0) throw errores.validacion(inconsistencias);

        const resultado = cuerpo.respuesta === "aceptado"
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
