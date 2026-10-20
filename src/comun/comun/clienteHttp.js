// Cliente HTTP con timeout y reintentos limitados (RNF-13).
// Pensado para llamar a M3, M4, M6... Lo puede reutilizar cualquier subequipo.
//
// Reglas:
//  - Siempre hay timeout: nunca se espera indefinidamente.
//  - Reintenta solo ante errores de red, timeout, 429 y 5xx (los 4xx no se reintentan).
//  - Un pedido que no es GET se reintenta SOLO si trae clave de idempotencia
//    (así un reintento no puede duplicar efectos, RNF-09).

class ErrorServicioExterno extends Error {
  constructor(mensaje, { estado = null, causa = null, intentos = 1 } = {}) {
    super(mensaje);
    this.name = "ErrorServicioExterno";
    this.estado = estado;
    this.causa = causa;
    this.intentos = intentos;
  }
}

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

function crearClienteHttp({
  baseUrl,
  timeoutMs = 2000,
  reintentos = 2,
  esperaBaseMs = 100,
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  if (!baseUrl) throw new Error("crearClienteHttp: falta baseUrl");
  const base = baseUrl.replace(/\/+$/, "");

  async function pedir(metodo, ruta, { cuerpo, claveIdempotencia, token } = {}) {
    const puedeReintentar = metodo === "GET" || Boolean(claveIdempotencia);
    const maxIntentos = puedeReintentar ? reintentos + 1 : 1;
    let ultimo = null;

    for (let intento = 1; intento <= maxIntentos; intento++) {
      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
      try {
        const encabezados = { accept: "application/json" };
        if (cuerpo !== undefined) encabezados["content-type"] = "application/json";
        if (claveIdempotencia) encabezados["idempotency-key"] = claveIdempotencia;
        if (token) encabezados.authorization = `Bearer ${token}`;

        const respuesta = await fetchImpl(base + ruta, {
          method: metodo,
          headers: encabezados,
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
          signal: controlador.signal,
        });

        const texto = await respuesta.text();
        if (respuesta.ok) {
          if (!texto) return null;
          try { return JSON.parse(texto); } catch { return texto; }
        }
        const reintentable = respuesta.status >= 500 || respuesta.status === 429;
        ultimo = new ErrorServicioExterno(`Respuesta ${respuesta.status} de ${ruta}`, {
          estado: respuesta.status,
          intentos: intento,
        });
        if (!reintentable) throw ultimo;
      } catch (error) {
        if (error instanceof ErrorServicioExterno && !(error.estado >= 500 || error.estado === 429)) {
          throw error; // 4xx: no tiene sentido reintentar
        }
        if (!(error instanceof ErrorServicioExterno)) {
          ultimo = new ErrorServicioExterno(
            error.name === "AbortError" ? `Timeout llamando a ${ruta}` : `Fallo de red llamando a ${ruta}`,
            { causa: error, intentos: intento }
          );
        }
      } finally {
        clearTimeout(temporizador);
      }
      if (intento < maxIntentos) {
        logger?.warn({ ruta, intento }, "reintentando llamada externa");
        await dormir(esperaBaseMs * 2 ** (intento - 1) + Math.floor(Math.random() * esperaBaseMs));
      }
    }
    ultimo.intentos = maxIntentos;
    throw ultimo;
  }

  return {
    get: (ruta, opciones) => pedir("GET", ruta, opciones),
    post: (ruta, cuerpo, opciones = {}) => pedir("POST", ruta, { ...opciones, cuerpo }),
  };
}

module.exports = { crearClienteHttp, ErrorServicioExterno };
