// API pública de src/comun. Los demás módulos importan SOLO desde acá.
module.exports = {
  ...require("./config"),
  ...require("./errores"),
  ...require("./roles"),
  ...require("./estados"),
  ...require("./logger"),
  ...require("./autenticacion"),
  ...require("./validacion"),
  ...require("./salud"),
  ...require("./clienteHttp"),
  ...require("./servidor"),
};
