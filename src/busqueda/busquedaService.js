// Búsqueda de candidatos (RF-5.3) según el contrato con M4
// (docs/contrato-interno-m5.md, sección 7.1).
//
//   M5 -> M4:  solicitud_id, origen_latitud, origen_longitud, destino_latitud, destino_longitud
//   M4 -> M5:  candidatos[] con conductor_id, distancia_m, tipo_vehiculo
//
// Reglas del contrato que se cumplen acá:
//  - El radio lo decide M4 (arranca con uno inicial y lo amplía según los conductores disponibles).
//    M5 NO manda radio ni lo filtra.
//  - Lista vacía = "no hay conductores". Es una respuesta válida: no se reintenta.
//  - Error, timeout o respuesta sin `candidatos[]` NO es lista vacía: se repite el intento y, si
//    sigue fallando, se lanza ErrorBusquedaCandidatos (nunca se declara agotada por un fallo de M4).
const { ordenarCandidatosPorDistancia } = require("./ranking");

class ErrorBusquedaCandidatos extends Error {
  constructor(mensaje, { causa = null, intentos = 0 } = {}) {
    super(mensaje);
    this.name = "ErrorBusquedaCandidatos";
    this.causa = causa;
    this.intentos = intentos;
  }
}

class ErrorDatosSolicitud extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "ErrorDatosSolicitud";
  }
}

const dormirReal = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Acepta { lat, lng } (clase Coordenada) o { latitud, longitud }.
function leerCoordenada(punto, nombre) {
  const latitud = punto?.latitud ?? punto?.lat;
  const longitud = punto?.longitud ?? punto?.lng;
  if (typeof latitud !== "number" || !Number.isFinite(latitud) || latitud < -90 || latitud > 90) {
    throw new ErrorDatosSolicitud(`${nombre}: la latitud debe ser un número entre -90 y 90`);
  }
  if (typeof longitud !== "number" || !Number.isFinite(longitud) || longitud < -180 || longitud > 180) {
    throw new ErrorDatosSolicitud(`${nombre}: la longitud debe ser un número entre -180 y 180`);
  }
  return { latitud, longitud };
}

// Cuerpo exacto que espera M4 (snake_case; los ids son string uuid).
function construirPedidoM4(solicitud) {
  const solicitudId = solicitud?.solicitudId;
  if (typeof solicitudId !== "string" || solicitudId.length === 0) {
    throw new ErrorDatosSolicitud("Falta solicitudId (string)");
  }
  const origen = leerCoordenada(solicitud.origen, "origen");
  const destino = leerCoordenada(solicitud.destino, "destino");
  return {
    solicitud_id: solicitudId,
    origen_latitud: origen.latitud,
    origen_longitud: origen.longitud,
    destino_latitud: destino.latitud,
    destino_longitud: destino.longitud,
  };
}

// Pide los candidatos y repite el intento si M4 falla. Devuelve el arreglo tal cual lo mandó M4.
async function pedirCandidatos(clienteM4, pedido, { intentos, esperaMs, dormir, logger }) {
  let ultimoError = null;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const respuesta = await clienteM4.consultarM4(pedido);
      if (!Array.isArray(respuesta?.candidatos)) {
        throw new Error("Respuesta de M4 inválida: falta candidatos[]");
      }
      return respuesta.candidatos;
    } catch (error) {
      ultimoError = error;
      logger?.warn({ err: error, intento, solicitudId: pedido.solicitud_id }, "falló la búsqueda de candidatos en M4");
      if (intento < intentos) await dormir(esperaMs * 2 ** (intento - 1));
    }
  }
  throw new ErrorBusquedaCandidatos(`M4 no respondió la búsqueda tras ${intentos} intentos`, {
    causa: ultimoError,
    intentos,
  });
}

// Pasa lo de M4 al estilo del resto del código y descarta lo inservible.
function normalizarCandidatos(crudos, tipoVehiculo) {
  const porConductor = new Map();
  for (const c of crudos) {
    if (typeof c?.conductor_id !== "string" || c.conductor_id.length === 0) continue;
    if (tipoVehiculo && String(c.tipo_vehiculo).toUpperCase() !== String(tipoVehiculo).toUpperCase()) continue;
    const distanciaM = Number.isFinite(c.distancia_m) ? c.distancia_m : Infinity;
    const anterior = porConductor.get(c.conductor_id);
    if (!anterior || distanciaM < anterior.distanciaM) {
      porConductor.set(c.conductor_id, { conductorId: c.conductor_id, distanciaM, tipoVehiculo: c.tipo_vehiculo });
    }
  }
  return [...porConductor.values()];
}

// `candidatos` (opcional) es el puerto de src/busqueda/repositorioCandidatos.js. Si se lo pasa, la lista se
// guarda apenas M4 responde: M4 ya reservó a esos conductores y hay que recordarlos para liberarlos después.
function crearBuscadorCandidatos({ clienteM4, candidatos, intentos = 3, esperaMs = 200, dormir = dormirReal, logger } = {}) {
  if (typeof clienteM4?.consultarM4 !== "function") throw new Error("Falta clienteM4.consultarM4");
  return {
    // -> [{ conductorId, distanciaM, tipoVehiculo }] ordenado del más cercano al más lejano. [] = no hay conductores.
    // `ronda` es el número de búsqueda de esta solicitud (1 la primera; 2 si hay que volver a pedir la lista).
    async buscar(solicitud, { ronda = 1, ahora } = {}) {
      const pedido = construirPedidoM4(solicitud);
      const crudos = await pedirCandidatos(clienteM4, pedido, { intentos, esperaMs, dormir, logger });
      const tipo = solicitud.tipoVehiculo ?? solicitud.tipoVehiculoRequerido;
      const lista = ordenarCandidatosPorDistancia(normalizarCandidatos(crudos, tipo), "distanciaM");
      if (candidatos && lista.length > 0) {
        await candidatos.guardar({ solicitudId: solicitud.solicitudId, ronda, lista, ...(ahora ? { ahora } : {}) });
      }
      return lista;
    },
  };
}

// Atajo con el cliente real. Se crea recién al usarlo, así este archivo se puede cargar sin axios.
let buscadorPorDefecto = null;
async function buscarYRankearCandidatos(datosSolicitud) {
  if (!buscadorPorDefecto) {
    const ClienteM3M4 = require("../clientes/ClienteM3M4");
    buscadorPorDefecto = crearBuscadorCandidatos({ clienteM4: new ClienteM3M4() });
  }
  return buscadorPorDefecto.buscar(datosSolicitud);
}

module.exports = {
  buscarYRankearCandidatos,
  crearBuscadorCandidatos,
  construirPedidoM4,
  ErrorBusquedaCandidatos,
  ErrorDatosSolicitud,
};
