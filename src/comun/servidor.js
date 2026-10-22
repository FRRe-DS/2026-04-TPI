// Arma la app Express con el orden correcto de middlewares (RNF-12).
//
// Orden y motivo:
//  1. contexto/log    -> todo request queda logueado con id de correlación
//  2. helmet          -> cabeceras de seguridad
//  3. /health         -> antes de autenticar (lo usa Docker/monitoreo)
//  4. rate limit      -> antes de autenticar (frena fuerza bruta)
//  5. autenticar      -> a partir de acá todo requiere JWT válido
//  6. parser JSON     -> recién con usuario autenticado y con límite de tamaño
//  7. rutas           -> cada una con requerirRol y validar
//  8. 404 y manejador de errores (siempre al final)
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { contextoDeRequest } = require("./logger");
const { crearRouterSalud } = require("./salud");
const { autenticar, requerirRol } = require("./autenticacion");
const { validar } = require("./validacion");
const { errores, manejadorErrores, rutaNoEncontrada } = require("./errores");

// registrarRutas(app, { requerirRol, validar }) lo llama cada subequipo para montar sus routers.
function crearApp({ config, logger, verificador, registrarRutas, chequeos }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.confiarEnProxy ? 1 : false);

  app.use(contextoDeRequest(logger));
  app.use(helmet());
  app.use(crearRouterSalud({ chequeos }));
  app.use(
    rateLimit({
      windowMs: config.rateLimit.ventanaMs,
      limit: config.rateLimit.maximo,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (req, res, next) => next(errores.demasiadosPedidos()),
    })
  );
  app.use(autenticar(verificador));
  app.use(express.json({ limit: config.bodyLimite }));

  if (registrarRutas) registrarRutas(app, { requerirRol, validar });

  app.use(rutaNoEncontrada);
  app.use(manejadorErrores(logger));
  return app;
}

module.exports = { crearApp };
