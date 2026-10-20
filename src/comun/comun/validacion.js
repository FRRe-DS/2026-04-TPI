// Validación de entrada con zod (RNF-12). Los datos ya validados quedan en
// req.validado.{params,query,body}; los handlers deben usar esos y no req.body.
const { errores } = require("./errores");

function validar(esquemas) {
  return (req, res, next) => {
    const detalles = [];
    req.validado = {};
    for (const parte of ["params", "query", "body"]) {
      const esquema = esquemas[parte];
      if (!esquema) continue;
      const resultado = esquema.safeParse(req[parte]);
      if (resultado.success) {
        req.validado[parte] = resultado.data;
      } else {
        for (const problema of resultado.error.issues) {
          detalles.push({
            campo: [parte, ...problema.path].join("."),
            mensaje: problema.message,
          });
        }
      }
    }
    if (detalles.length > 0) return next(errores.validacion(detalles));
    return next();
  };
}

module.exports = { validar };
