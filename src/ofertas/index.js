// API pública del módulo de ofertas (despacho por tandas). Los demás importan SOLO desde acá.
module.exports = {
  ...require("./despacho"),
  ...require("./jobTandas"),
};
