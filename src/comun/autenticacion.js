// Autenticación (JWT de M1) y autorización por rol (RNF-12).
//
// El verificador es una pieza intercambiable: hoy valida el JWT localmente.
// Si M1 ofrece un endpoint de validación (RF-1.4), se escribe otro verificador
// con la misma firma `async (token) => identidad` y no cambia nada más.
const jwt = require("jsonwebtoken");
const { errores } = require("./errores");
const { normalizarRol } = require("./roles");

function construirIdentidad(claims, cfg) {
  const identidadId = claims[cfg.claimIdentidad];
  const esValido =
    (typeof identidadId === "string" && identidadId.length > 0) ||
    typeof identidadId === "number";
  if (!esValido) throw errores.noAutenticado();

  const brutos = claims[cfg.claimRoles];
  const lista = Array.isArray(brutos) ? brutos : brutos ? [brutos] : [];
  const roles = lista.map(normalizarRol).filter(Boolean);

  const conductor = cfg.claimConductor ? claims[cfg.claimConductor] : null;

  return Object.freeze({
    identidadId: String(identidadId),
    roles,
    conductorId: conductor ? String(conductor) : null,
  });
}

function crearVerificadorLocal(config) {
  const cfg = config.jwt;
  const clave = cfg.algoritmo.startsWith("HS") ? cfg.secreto : cfg.clavePublica;

  // `algorithms` explícito: el algoritmo "none" y el cambio de algoritmo quedan rechazados.
  const opciones = { algorithms: [cfg.algoritmo], clockTolerance: 5 };
  if (cfg.issuer) opciones.issuer = cfg.issuer;
  if (cfg.audience) opciones.audience = cfg.audience;

  return async function verificar(token) {
    let claims;
    try {
      claims = jwt.verify(token, clave, opciones);
    } catch {
      // Mensaje genérico: no revelamos si falló la firma, el vencimiento, etc.
      throw errores.noAutenticado();
    }
    return construirIdentidad(claims, cfg);
  };
}

function autenticar(verificador) {
  return async (req, res, next) => {
    try {
      const encabezado = req.get("authorization") || "";
      const [esquema, token, ...resto] = encabezado.split(" ");
      if (!esquema || esquema.toLowerCase() !== "bearer" || !token || resto.length > 0) {
        throw errores.noAutenticado();
      }
      req.identidad = await verificador(token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requerirRol(...permitidos) {
  const aceptados = new Set(permitidos.map(normalizarRol));
  return (req, res, next) => {
    if (!req.identidad) return next(errores.noAutenticado());
    const autorizado = req.identidad.roles.some((rol) => aceptados.has(rol));
    return next(autorizado ? undefined : errores.prohibido());
  };
}

module.exports = { crearVerificadorLocal, autenticar, requerirRol, construirIdentidad };
