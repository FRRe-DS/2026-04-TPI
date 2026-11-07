// Esquemas de validación de entrada para los endpoints de asignación.
const { z } = require("zod");

const esquemaParamsOferta = z
  .object({ ofertaId: z.string().uuid("ofertaId debe ser un UUID válido") })
  .strict();

// Contrato con M3: el conductor responde con los ids y "aceptado" o "rechazado".
// solicitud_id y conductor_id se piden como texto no vacío (se comparan con lo guardado en la oferta);
// oferta_id es un UUID.
const idTexto = (nombre) =>
  z
    .string({ required_error: `${nombre} es obligatorio`, invalid_type_error: `${nombre} debe ser texto` })
    .min(1, `${nombre} no puede estar vacío`)
    .max(64, `${nombre} es demasiado largo`);

const esquemaRespuestaOferta = z
  .object({
    solicitud_id: idTexto("solicitud_id"),
    oferta_id: z.string({ required_error: "oferta_id es obligatorio" }).uuid("oferta_id debe ser un UUID válido"),
    conductor_id: idTexto("conductor_id"),
    respuesta: z.enum(["aceptado", "rechazado"], {
      errorMap: () => ({ message: 'respuesta debe ser "aceptado" o "rechazado"' }),
    }),
  })
  .strict();

const esquemaParamsSolicitud = z
  .object({ solicitudId: z.string().uuid("solicitudId debe ser un UUID válido") })
  .strict();

module.exports = { esquemaParamsOferta, esquemaRespuestaOferta, esquemaParamsSolicitud };
