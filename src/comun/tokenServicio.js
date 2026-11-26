// Obtiene un JWT de servicio de Keycloak para las llamadas salientes de M5.
// El token se reutiliza hasta 30 segundos antes de vencer.
let tokenCache = null;
let solicitudEnCurso = null;

async function obtenerTokenServicio() {
  const ahora = Date.now();
  if (tokenCache && tokenCache.venceEn > ahora + 30_000) return tokenCache.valor;
  if (solicitudEnCurso) return solicitudEnCurso;

  solicitudEnCurso = (async () => {
    try {
      // Preferir una cuenta dedicada; en el entorno escolar puede reutilizarse el cliente confidencial del BFF.
      const clienteId = process.env.M5_SERVICE_CLIENT_ID || process.env.KEYCLOAK_ADMIN_CLIENT_ID;
      const secreto = process.env.M5_SERVICE_CLIENT_SECRET || process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
      if (!clienteId || !secreto) {
        throw new Error("Configurá M5_SERVICE_CLIENT_ID/M5_SERVICE_CLIENT_SECRET o las credenciales KEYCLOAK_ADMIN_* del BFF para pedir el token M2M.");
      }

      const url = (process.env.KEYCLOAK_URL || "http://localhost:8080").replace(/\/$/, "");
      const realm = encodeURIComponent(process.env.KEYCLOAK_REALM || "ds-2026-realm");
      const endpoint = `${url}/realms/${realm}/protocol/openid-connect/token`;
      const controlador = new AbortController();
      const timeout = setTimeout(() => controlador.abort(), 3000);
      try {
        const parametros = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clienteId,
          client_secret: secreto,
        });
        const respuesta = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: parametros,
          signal: controlador.signal,
        });
        if (!respuesta.ok) throw new Error(`Keycloak respondió HTTP ${respuesta.status} al pedir token M2M.`);
        const cuerpo = await respuesta.json();
        if (typeof cuerpo.access_token !== "string" || !cuerpo.access_token) {
          throw new Error("Keycloak no devolvió access_token.");
        }
        const vidaMs = Math.max(1, Number(cuerpo.expires_in || 60) - 30) * 1000;
        tokenCache = { valor: cuerpo.access_token, venceEn: Date.now() + vidaMs };
        return tokenCache.valor;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      solicitudEnCurso = null;
    }
  })();

  return solicitudEnCurso;
}

function limpiarTokenServicio() {
  tokenCache = null;
  solicitudEnCurso = null;
}

module.exports = { obtenerTokenServicio, limpiarTokenServicio };
