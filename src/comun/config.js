// Configuración por variables de entorno (RNF-06). Falla al arrancar si algo
// esencial falta: es mejor no iniciar que correr sin seguridad.

const ALGORITMOS_PERMITIDOS = [
  "HS256", "HS384", "HS512",
  "RS256", "RS384", "RS512",
  "ES256", "ES384", "ES512",
];

function leerConfig(env = process.env) {
  const problemas = [];

  const algoritmo = env.JWT_ALGORITMO || "HS256";
  if (!ALGORITMOS_PERMITIDOS.includes(algoritmo)) {
    problemas.push(`JWT_ALGORITMO inválido (permitidos: ${ALGORITMOS_PERMITIDOS.join(", ")})`);
  }

  const esSimetrico = algoritmo.startsWith("HS");
  const secreto = env.JWT_SECRETO || "";
  const clavePublica = (env.JWT_CLAVE_PUBLICA || "").replace(/\\n/g, "\n");

  if (esSimetrico) {
    if (!secreto) problemas.push("Falta JWT_SECRETO");
    else if (secreto.length < 32) problemas.push("JWT_SECRETO debe tener al menos 32 caracteres");
  } else if (!clavePublica) {
    problemas.push("Falta JWT_CLAVE_PUBLICA");
  }

  const entero = (nombre, porDefecto) => {
    const valor = env[nombre] === undefined ? porDefecto : Number(env[nombre]);
    if (!Number.isInteger(valor) || valor <= 0) {
      problemas.push(`${nombre} debe ser un entero positivo`);
    }
    return valor;
  };

  const config = {
    puerto: entero("PORT", 3000),
    nivelLog: env.LOG_LEVEL || "info",
    bodyLimite: env.BODY_LIMITE || "10kb",
    confiarEnProxy: env.TRUST_PROXY === "true",
    rateLimit: {
      ventanaMs: entero("RATE_LIMIT_VENTANA_MS", 60000),
      maximo: entero("RATE_LIMIT_MAX", 120),
    },
    jwt: {
      algoritmo,
      secreto,
      clavePublica,
      issuer: env.JWT_ISSUER || null,
      audience: env.JWT_AUDIENCE || null,
      // Nombres de los claims: a confirmar con M1.
      claimIdentidad: env.JWT_CLAIM_IDENTIDAD || "sub",
      claimRoles: env.JWT_CLAIM_ROLES || "roles",
      claimConductor: env.JWT_CLAIM_CONDUCTOR || null,
    },
  };

  if (problemas.length > 0) {
    throw new Error("Configuración inválida:\n- " + problemas.join("\n- "));
  }
  return Object.freeze(config);
}

module.exports = { leerConfig, ALGORITMOS_PERMITIDOS };
