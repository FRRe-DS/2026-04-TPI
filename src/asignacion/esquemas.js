// Esquemas de validación de entrada para los endpoints de asignación.
const { z } = require("zod");

const esquemaParamsOferta = z
  .object({ ofertaId: z.string().uuid("ofertaId debe ser un UUID válido") })
  .strict();

const esquemaRespuestaOferta = z
  .object({
    acepta: z.boolean({
      required_error: "acepta es obligatorio",
      invalid_type_error: "acepta debe ser verdadero o falso",
    }),
  })
  .strict();

const esquemaParamsSolicitud = z
  .object({ solicitudId: z.string().uuid("solicitudId debe ser un UUID válido") })
  .strict();

module.exports = { esquemaParamsOferta, esquemaRespuestaOferta, esquemaParamsSolicitud };
