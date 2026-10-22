// EJEMPLO de cómo se combinan las piezas en el endpoint POST /ofertas/:ofertaId/respuesta.
// El endpoint real es de Azul (B2): este router muestra el orden correcto de las piezas
// y sirve para probar de punta a punta la seguridad + la asignación única.
const express = require("express");
const { ROLES, errores, asociarSolicitud } = require("../../src/comun");
const {
  procesarAceptacion,
  verificarConductorDeOferta,
  esquemaParamsOferta,
  esquemaRespuestaOferta,
  estadoHttp,
  cuerpoHttp,
} = require("../../src/asignacion");

function crearRouterRespuesta({ deps, requerirRol, validar }) {
  const router = express.Router();

  router.post(
    "/ofertas/:ofertaId/respuesta",
    requerirRol(ROLES.CONDUCTOR), // 1) rol
    validar({ params: esquemaParamsOferta, body: esquemaRespuestaOferta }), // 2) entrada
    async (req, res, next) => {
      try {
        const { ofertaId } = req.validado.params;
        const oferta = await deps.ofertas.obtenerPorId(ofertaId);
        if (!oferta) throw errores.noEncontrado("La oferta no existe");

        // 3) el conductor del token debe ser el dueño de la oferta
        const conductorId = await verificarConductorDeOferta({ identidad: req.identidad, oferta });
        asociarSolicitud(req, oferta.solicitudId); // 4) los logs quedan con solicitudId

        if (!req.validado.body.acepta) {
          // El rechazo lo implementa Azul (RF-5.5); acá no se necesita.
          return res.status(501).json({ error: { codigo: "NO_IMPLEMENTADO", mensaje: "Rechazo pendiente" } });
        }
        const r = await procesarAceptacion({ ofertaId, conductorId }, deps); // 5) asignación única
        return res.status(estadoHttp(r.resultado)).json(cuerpoHttp(r));
      } catch (error) {
        return next(error);
      }
    }
  );
  return router;
}

module.exports = { crearRouterRespuesta };
