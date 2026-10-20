// Logger estructurado con id de correlación y solicitudId (RNF-12).
const pino = require("pino");
const { randomUUID } = require("node:crypto");

function crearLogger({ nivel = "info", destino } = {}) {
  return pino(
    {
      level: nivel,
      // El token y las credenciales nunca deben quedar en los logs.
      redact: {
        paths: [
          "req.headers.authorization",
          "headers.authorization",
          "authorization",
          "token",
          "*.token",
          "*.password",
        ],
        censor: "[REDACTADO]",
      },
    },
    destino
  );
}

// Solo aceptamos ids entrantes con formato seguro (evita inyección en logs).
const ID_VALIDO = /^[A-Za-z0-9-]{8,64}$/;

function contextoDeRequest(logger) {
  return (req, res, next) => {
    const entrante = req.get("x-request-id");
    req.id = entrante && ID_VALIDO.test(entrante) ? entrante : randomUUID();
    res.setHeader("x-request-id", req.id);
    req.log = logger.child({ reqId: req.id });

    const inicio = process.hrtime.bigint();
    res.on("finish", () => {
      req.log.info(
        {
          metodo: req.method,
          ruta: req.originalUrl.split("?")[0], // sin query string
          estado: res.statusCode,
          ms: Number(process.hrtime.bigint() - inicio) / 1e6,
        },
        "request"
      );
    });
    next();
  };
}

// Agrega solicitudId a todos los logs posteriores de este request.
function asociarSolicitud(req, solicitudId) {
  req.log = req.log.child({ solicitudId });
}

// Uso: registrarParamSolicitud(router) -> todo router con :solicitudId queda logueado.
function registrarParamSolicitud(router) {
  router.param("solicitudId", (req, res, next, id) => {
    asociarSolicitud(req, id);
    next();
  });
}

module.exports = { crearLogger, contextoDeRequest, asociarSolicitud, registrarParamSolicitud };
