// API pública del módulo de asignación. Los demás importan SOLO desde acá.
module.exports = {
  ...require("./resultados"),
  ...require("./procesarAceptacion"),
  ...require("./procesarCancelacion"),
  ...require("./busquedaAgotada"),
  ...require("./autorizacionOferta"),
  ...require("./esquemas"),
  ...require("./notificaciones"),
  ...require("./puertos"),
  ...require("./transacciones"),
};
