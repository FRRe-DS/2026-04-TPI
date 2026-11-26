// M3 responde en POST /api/v1/offers/:offerId/driver-response con su contrato en inglés.
// Las rutas /ofertas/:ofertaId/{responder,respuesta} se conservan como compatibilidad interna.
//
// Es un ORQUESTADOR: no decide nada de negocio. Aplica los controles de seguridad en orden y
// llama a procesarAceptacion o procesarRechazo; después traduce el resultado a HTTP.
//
// En la ruta M3, M5 obtiene solicitud_id desde la oferta y oculta ofertas ajenas con 404.
// La aceptación/rechazo sigue pasando por los mismos flujos transaccionales e idempotentes.
// Cualquier error inesperado va a next(error): el manejador final responde un 500 genérico.
const express = require("express");
const { ROLES, errores, asociarSolicitud } = require("../comun");
const {
  procesarAceptacion,
  esquemaParamsOferta,
  esquemaParamsOfertaM3,
  esquemaDecisionM3,
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

  // Adaptador del contrato actual de M3 al modelo interno de respuesta de M5.
  const responderDesdeM3 = async (req, res, next) => {
    try {
      const { offerId } = req.validado.params;
      const { driverId, decision } = req.validado.body;
      const claveIdempotencia = req.get("Idempotency-Key");
      if (!claveIdempotencia || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claveIdempotencia)) {
        throw errores.validacion([{ campo: "headers.Idempotency-Key", mensaje: "Idempotency-Key debe ser un UUID" }]);
      }

      const oferta = await deps.ofertas.obtenerPorId(offerId);
      // El contrato M3 usa 404 tanto para ofertas inexistentes como ajenas.
      if (!oferta || oferta.conductorId !== driverId) {
        throw errores.noEncontrado("Oferta desconocida o no asignada al conductor");
      }
      asociarSolicitud(req, oferta.solicitudId);

      const resultado = decision === "ACCEPTED"
        ? await procesarAceptacion({ ofertaId: offerId, conductorId: driverId }, deps)
        : await procesarRechazo({ ofertaId: offerId, conductorId: driverId }, deps);

      if (resultado.resultado === "asignada" && !resultado.tripId) {
        return res.status(503).json({ error: "La asignación quedó registrada, pero M5 no pudo confirmar el viaje en M6. M3 puede reintentar." });
      }
      if (resultado.resultado === "asignada") {
        return res.status(200).json({ status: "ACCEPTED", tripId: resultado.tripId });
      }
      if (resultado.resultado === "rechazada") {
        return res.status(200).json({ status: "REJECTED", tripId: null });
      }

      return res.status(estadoHttpRespuesta(resultado.resultado)).json(cuerpoHttpRespuesta(resultado));
    } catch (error) {
      return next(error);
    }
  };

  router.post(
    "/offers/:offerId/driver-response",
    autorizarM3,
    validar({ params: esquemaParamsOfertaM3, body: esquemaDecisionM3 }),
    responderDesdeM3
  );

  // Se conservan las rutas previas de M5 para no romper clientes existentes.
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
