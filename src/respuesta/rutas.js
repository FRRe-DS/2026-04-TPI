// Endpoint POST /api/v1/ofertas/:ofertaId/responder (RF-5.5): M3 remite la decisión autenticado por scope.
// Cuerpo: { solicitud_id, oferta_id, conductor_id, respuesta: "aceptado" | "rechazado" }.
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
  esquemaParamsOferta,
  esquemaRespuestaOferta,
} = require("../asignacion");
const { procesarRechazo } = require("./procesarRechazo");
const { estadoHttpRespuesta, cuerpoHttpRespuesta } = require("./resultadosRespuesta");

// `resolverConductorId` es opcional: cómo pasar de la identidad del token al conductorId de la
// oferta (por defecto, el claim configurado en JWT_CLAIM_CONDUCTOR).
function crearRouterRespuesta({ deps, requerirRol, requerirScope, validar }) {
  const router = express.Router();
  const autorizarM3 = typeof requerirScope === "function"
    ? requerirScope("m5:offers:respond")
    : requerirRol(ROLES.CONDUCTOR);

  router.post(
    ["/ofertas/:ofertaId/responder", "/ofertas/:ofertaId/respuesta"],
    autorizarM3,
    validar({ params: esquemaParamsOferta, body: esquemaRespuestaOferta }),
    async (req, res, next) => {
      try {
        const { ofertaId } = req.validado.params;
        const cuerpo = req.validado.body;
        const oferta = await deps.ofertas.obtenerPorId(ofertaId);
        if (!oferta) throw errores.noEncontrado("La oferta no existe");

        const conductorId = cuerpo.conductor_id;
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

        if (resultado.resultado === "asignada" && !resultado.tripId) {
          return res.status(503).json({ error: "La asignación quedó registrada, pero M5 no pudo confirmar el viaje en M6. M3 puede reintentar." });
        }
        const respuestaHttp = cuerpoHttpRespuesta(resultado);
        if (resultado.resultado === "asignada") {
          respuestaHttp.status = "ACCEPTED";
          respuestaHttp.tripId = resultado.tripId;
        } else if (resultado.resultado === "rechazada") {
          respuestaHttp.status = "REJECTED";
          respuestaHttp.tripId = null;
        }
        return res.status(estadoHttpRespuesta(resultado.resultado)).json(respuestaHttp);
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = { crearRouterRespuesta };
