// Errores de la aplicación y manejador final de Express (RNF-12).
// NOTA: alinear estos códigos con el catálogo común de errores (RNF-03) que arma Lautaro.

class AppError extends Error {
  constructor(status, codigo, mensaje, detalles) {
    super(mensaje);
    this.name = "AppError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

const errores = {
  noAutenticado: () =>
    new AppError(401, "NO_AUTENTICADO", "Credenciales ausentes o inválidas"),
  prohibido: (mensaje = "No tenés permiso para realizar esta operación") =>
    new AppError(403, "PROHIBIDO", mensaje),
  noEncontrado: (mensaje = "Recurso no encontrado") =>
    new AppError(404, "NO_ENCONTRADO", mensaje),
  validacion: (detalles) =>
    new AppError(400, "VALIDACION", "Datos de entrada inválidos", detalles),
  conflicto: (codigo, mensaje) => new AppError(409, codigo, mensaje),
  vencido: (codigo, mensaje) => new AppError(410, codigo, mensaje),
  demasiadosPedidos: () =>
    new AppError(429, "DEMASIADOS_PEDIDOS", "Demasiados pedidos, probá más tarde"),
  noDisponible: (mensaje = "Servicio no disponible") =>
    new AppError(503, "NO_DISPONIBLE", mensaje),
};

// Manejador final. Nunca devuelve el stack ni mensajes internos al cliente.
function manejadorErrores(logger) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const log = req.log || logger;

    if (err instanceof AppError) {
      if (err.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
      const cuerpo = { codigo: err.codigo, mensaje: err.message };
      if (err.detalles) cuerpo.detalles = err.detalles;
      return res.status(err.status).json({ error: cuerpo });
    }
    if (err && err.type === "entity.parse.failed") {
      return res
        .status(400)
        .json({ error: { codigo: "JSON_INVALIDO", mensaje: "El cuerpo no es un JSON válido" } });
    }
    if (err && err.type === "entity.too.large") {
      return res
        .status(413)
        .json({ error: { codigo: "CUERPO_MUY_GRANDE", mensaje: "El cuerpo supera el tamaño permitido" } });
    }
    log.error({ err }, "error no controlado");
    return res
      .status(500)
      .json({ error: { codigo: "ERROR_INTERNO", mensaje: "Error interno del servidor" } });
  };
}

function rutaNoEncontrada(req, res) {
  res
    .status(404)
    .json({ error: { codigo: "RUTA_INEXISTENTE", mensaje: "La ruta no existe" } });
}

module.exports = { AppError, errores, manejadorErrores, rutaNoEncontrada };
