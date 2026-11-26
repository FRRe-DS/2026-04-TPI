const jwt = require("jsonwebtoken");

// Emite en memoria un token de desarrollo compatible con el modo HS256 de M2.
// M2_TOKEN, si se definió manualmente, siempre tiene prioridad.
let tokenCache = null;

async function obtenerTokenM2() {
  const tokenConfigurado = process.env.M2_TOKEN?.trim();
  if (tokenConfigurado) return tokenConfigurado;

  if ((process.env.M2_MODO_TOKENS || "").toLowerCase() !== "hs256") {
    throw new Error("M2_TOKEN está vacío: define M2_MODO_TOKENS=hs256 y la clave compartida, o configura un proveedor Keycloak.");
  }

  const clave = process.env.M2_CLAVE_TOKENS;
  if (!clave) throw new Error("Falta M2_CLAVE_TOKENS para firmar el token local que M2 valida.");

  const ahora = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.venceEn > ahora + 10) return tokenCache.valor;

  const venceEn = ahora + 60;
  const campoRoles = process.env.M2_CAMPO_ROLES || "roles";
  const valor = jwt.sign(
    { [campoRoles]: ["SERVICIO"] },
    clave,
    {
      algorithm: "HS256",
      issuer: process.env.M2_EMISOR_TOKENS || "m1-identidad",
      audience: process.env.M2_AUDIENCIA_TOKENS || "m2-clientes",
      subject: process.env.M5_SERVICE_SUB || "m5-solicitudes",
      expiresIn: 60,
    }
  );
  tokenCache = { valor, venceEn };
  return valor;
}

module.exports = { obtenerTokenM2 };
