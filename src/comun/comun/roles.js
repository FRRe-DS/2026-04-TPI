// Roles del enunciado (RF-1.3): Cliente, Conductor y Operador/Administrador.
const ROLES = Object.freeze({
  CLIENTE: "CLIENTE",
  CONDUCTOR: "CONDUCTOR",
  OPERADOR: "OPERADOR",
  ADMINISTRADOR: "ADMINISTRADOR",
});

function normalizarRol(rol) {
  return typeof rol === "string" ? rol.trim().toUpperCase() : null;
}

module.exports = { ROLES, normalizarRol };
