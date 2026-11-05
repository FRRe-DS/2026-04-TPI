// API pública del módulo de respuesta del conductor (B2). Los demás importan SOLO desde acá.
module.exports = {
  ...require("./resultadosRespuesta"),
  ...require("./procesarRechazo"),
  ...require("./jobVencimientos"),
  ...require("./repositorioOfertas"),
  ...require("./rutas"),
};
