// Despacho por tandas (RF-5.4): las ofertas no salen a todos a la vez, sino de a pocos conductores,
// empezando por los más cercanos.
//
//   Tanda 1: los 3 primeros de la lista (los más cercanos).
//   +20 s sin asignación: la tanda 2, los 3 siguientes. Y así hasta agotar la lista o el plazo.
//   Si todos los de una tanda rechazan o vencen antes de los 20 s, la siguiente sale enseguida
//   (evaluarBusquedaAgotada adelanta la tanda cuando no queda ninguna oferta pendiente).
//
// Cada oferta vive 30 s (vence_en), así que la oferta de una tanda sigue vigente 10 s cuando sale la
// siguiente: el que acepta primero gana (asignación única) y los demás reciben 409 / 410.
//
// Para cada tanda:
//   1. Se "reclama" el turno con una escritura condicional (busquedas.reclamarTanda): aunque haya varias
//      instancias o el job y el flujo directo coincidan, la tanda sale una sola vez.
//   2. Se reserva en M4 a un conductor por vez, en orden (reserva.js). Los que M4 rechaza por conflicto
//      se omiten para siempre; si M4 falla, quedan para la próxima tanda.
//   3. En una transacción se crean las ofertas y se actualiza cuántos candidatos quedan.
//   4. Recién con eso confirmado se mandan las ofertas a M3 (un solo envío por tanda).
//
// Qué pasa si algo falla:
//   - M3 no recibe el lote: las ofertas quedan pendientes, vencen a los 30 s y el flujo de vencimiento
//     libera a los conductores y adelanta la tanda siguiente. No se pierde ninguna reserva.
//   - La búsqueda se cerró mientras se reservaba (el cliente canceló, alguien aceptó): se libera a los
//     conductores recién reservados y no se crea ninguna oferta. Es una comprobación previa, no un
//     bloqueo; la garantía final sigue siendo que aceptar/rechazar es condicional en la base.
const { randomUUID } = require("node:crypto");
const { TipoEvento } = require("../comun/estados");
const {
  RevertirTransaccion,
  conReintentoPorDeadlock,
  evaluarBusquedaAgotada,
  procesarBusquedaAgotada,
  reservarConductores,
  liberarYMarcar,
} = require("../asignacion");

// Valores propuestos (no están en ningún contrato). Se pueden cambiar con deps.despacho.
const CONFIG_DESPACHO = Object.freeze({
  tamanoTanda: 3, // conductores por tanda
  esperaTandaMs: 20_000, // desde una tanda hasta la siguiente
  vigenciaOfertaMs: 30_000, // vence_en de cada oferta (contrato con M3)
  plazoBusquedaMs: 180_000, // límite total de la búsqueda antes de declararla agotada
});

function leerConfig(deps) {
  const cfg = { ...CONFIG_DESPACHO, ...(deps.despacho ?? {}) };
  if (!Number.isInteger(cfg.tamanoTanda) || cfg.tamanoTanda < 1 || cfg.tamanoTanda > 10) {
    throw new Error("despacho.tamanoTanda debe ser un entero entre 1 y 10");
  }
  for (const campo of ["esperaTandaMs", "vigenciaOfertaMs", "plazoBusquedaMs"]) {
    if (!Number.isFinite(cfg[campo]) || cfg[campo] <= 0) throw new Error(`despacho.${campo} debe ser un número positivo`);
  }
  return cfg;
}

const REQUERIDOS = {
  solicitudes: ["obtenerDatosViaje"],
  ofertas: ["crearTanda"],
  busquedas: ["obtenerActiva", "crear", "reclamarTanda", "registrarTanda", "listarTandasVencidas"],
  candidatos: ["pendientesDeOfertar", "marcarOmitidos", "marcarReservado"],
  notificaciones: ["enviarOfertas", "reservarConductor"],
  eventos: ["registrar"],
};

function validarDependenciasDespacho(deps, { conBuscador = false } = {}) {
  const faltantes = [];
  if (typeof deps?.ejecutarEnTransaccion !== "function") faltantes.push("ejecutarEnTransaccion");
  if (conBuscador && typeof deps?.buscador?.buscar !== "function") faltantes.push("buscador.buscar");
  for (const [puerto, metodos] of Object.entries(REQUERIDOS)) {
    for (const metodo of metodos) {
      if (typeof deps?.[puerto]?.[metodo] !== "function") faltantes.push(`${puerto}.${metodo}`);
    }
  }
  if (faltantes.length > 0) throw new Error("Faltan dependencias para el despacho: " + faltantes.join(", "));
}

const sumarMs = (fecha, ms) => new Date(new Date(fecha).getTime() + ms);

// Libera (sin motivo) a los conductores que se reservaron para una tanda que no salió.
async function soltarReservados({ solicitudId, reservados }, deps) {
  try {
    await liberarYMarcar(
      { solicitudId, items: reservados.map((c) => ({ solicitudId, conductorId: c.conductorId })) },
      deps
    );
  } catch (error) {
    deps.logger?.error({ err: error, solicitudId }, "no se pudo liberar a los reservados de una tanda cancelada");
  }
}

// Manda UNA tanda. Devuelve { resultado, ... }:
//   enviada | enviada_con_error | sin_turno | sin_busqueda_activa | plazo_vencido |
//   sin_candidatos | m4_no_responde | busqueda_cerrada | solicitud_inexistente
async function enviarTanda({ solicitudId, datosViaje = null }, deps) {
  validarDependenciasDespacho(deps);
  const cfg = leerConfig(deps);
  const ahora = (deps.reloj ?? (() => new Date()))();

  const busqueda = await deps.busquedas.obtenerActiva(solicitudId);
  if (!busqueda) return { resultado: "sin_busqueda_activa" };

  // Pasado el plazo no salen más tandas. Si no queda ninguna oferta pendiente, la búsqueda se agota.
  if (ahora >= new Date(busqueda.venceEn)) {
    await evaluarBusquedaAgotada({ solicitudId }, deps);
    return { resultado: "plazo_vencido" };
  }

  // Turno: solo una llamada gana cada tanda (condicional sobre proximaTandaEn).
  const turno = await deps.busquedas.reclamarTanda({
    solicitudId,
    ahora,
    proximaTandaEn: sumarMs(ahora, cfg.esperaTandaMs),
  });
  if (!turno) return { resultado: "sin_turno" };

  const datos = datosViaje ?? (await deps.solicitudes.obtenerDatosViaje(solicitudId));
  if (!datos) return { resultado: "solicitud_inexistente" };

  const pendientes = await deps.candidatos.pendientesDeOfertar({ solicitudId });
  if (pendientes.length === 0) {
    await evaluarBusquedaAgotada({ solicitudId }, deps);
    return { resultado: "sin_candidatos" };
  }

  const { reservados, conflictos, fallidos } = await reservarConductores(
    { solicitudId, candidatos: pendientes, cantidad: cfg.tamanoTanda },
    deps
  );
  if (conflictos.length > 0) {
    await deps.candidatos.marcarOmitidos({ solicitudId, conductorIds: conflictos, ahora });
  }
  // Los que fallaron por un error de M4 no se descartan: quedan para la próxima tanda.
  const restantes = pendientes.length - conflictos.length - reservados.length;

  if (reservados.length === 0) {
    await deps.busquedas.registrarTanda({ solicitudId, candidatosRestantes: restantes });
    if (fallidos.length > 0) {
      deps.logger?.warn({ solicitudId, fallidos: fallidos.length }, "M4 no pudo reservar a nadie: se reintenta en la próxima tanda");
      return { resultado: "m4_no_responde", restantes };
    }
    await evaluarBusquedaAgotada({ solicitudId }, deps); // todos eran conflictos: no queda nadie
    return { resultado: "sin_candidatos", conflictos };
  }

  const venceEn = sumarMs(ahora, cfg.vigenciaOfertaMs);
  const ofertas = reservados.map((c) => ({ ofertaId: randomUUID(), conductorId: c.conductorId }));

  try {
    await conReintentoPorDeadlock(() =>
      deps.ejecutarEnTransaccion(async (tx) => {
        if (!(await deps.busquedas.obtenerActiva(solicitudId, tx))) throw new RevertirTransaccion("BUSQUEDA_CERRADA");
        await deps.ofertas.crearTanda({ solicitudId, ofertas, venceEn, ahora }, tx);
        for (const o of ofertas) {
          await deps.eventos.registrar(
            { solicitudId, tipo: TipoEvento.OFERTA, conductorId: o.conductorId, ofertaId: o.ofertaId, ocurridoEn: ahora, detalle: "Oferta emitida" },
            tx
          );
        }
        await deps.busquedas.registrarTanda({ solicitudId, candidatosRestantes: restantes }, tx);
      })
    );
  } catch (error) {
    await soltarReservados({ solicitudId, reservados }, deps);
    if (error instanceof RevertirTransaccion) return { resultado: "busqueda_cerrada" };
    throw error;
  }

  // Con las ofertas ya guardadas se avisa a M3 (un solo envío por tanda).
  try {
    await deps.notificaciones.enviarOfertas({
      solicitudId,
      ofertas,
      origen: datos.origen,
      destino: datos.destino,
      tipoVehiculo: datos.tipoVehiculo,
      venceEn,
    });
  } catch (error) {
    deps.logger?.error({ err: error, solicitudId }, "no se pudo enviar el lote de ofertas a M3");
    await deps.eventos
      .registrar({ solicitudId, tipo: TipoEvento.OFERTA, ocurridoEn: ahora, detalle: `No se pudo enviar el lote a M3: ${error.message}` })
      .catch(() => {});
    return { resultado: "enviada_con_error", ofertas, restantes };
  }
  return { resultado: "enviada", ofertas, restantes };
}

// Arranca el despacho de una solicitud que ya está en `buscando`: pide la lista a M4, abre la búsqueda y
// manda la primera tanda. Seguro de repetir: si la búsqueda ya existe, no hace nada.
// solicitud: { solicitudId, origen: { latitud, longitud }, destino: { ... }, tipoVehiculo }
// Si M4 no responde la búsqueda lanza ErrorBusquedaCandidatos y no deja nada creado: quien llama decide
// si reintenta (nunca se declara "sin conductores" por un error de M4).
async function iniciarDespacho({ solicitud }, deps) {
  validarDependenciasDespacho(deps, { conBuscador: true });
  const cfg = leerConfig(deps);
  const ahora = (deps.reloj ?? (() => new Date()))();
  const solicitudId = solicitud?.solicitudId;
  if (typeof solicitudId !== "string" || solicitudId.length === 0) throw new Error("Falta solicitud.solicitudId");

  if (await deps.busquedas.obtenerActiva(solicitudId)) return { resultado: "ya_iniciado" };

  const lista = await deps.buscador.buscar(solicitud, { ahora });
  if (lista.length === 0) {
    const r = await procesarBusquedaAgotada({ solicitudId, motivo: "SIN_CANDIDATOS" }, deps);
    return { resultado: "sin_candidatos", ...r };
  }

  await conReintentoPorDeadlock(() =>
    deps.ejecutarEnTransaccion(async (tx) => {
      await deps.busquedas.crear(
        { solicitudId, venceEn: sumarMs(ahora, cfg.plazoBusquedaMs), candidatosRestantes: lista.length, proximaTandaEn: ahora },
        tx
      );
      await deps.eventos.registrar(
        { solicitudId, tipo: TipoEvento.BUSQUEDA, ocurridoEn: ahora, detalle: `Búsqueda iniciada: ${lista.length} candidatos` },
        tx
      );
    })
  );

  const tanda = await enviarTanda(
    { solicitudId, datosViaje: { origen: solicitud.origen, destino: solicitud.destino, tipoVehiculo: solicitud.tipoVehiculo } },
    deps
  );
  return { resultado: "iniciado", candidatos: lista.length, tanda };
}

module.exports = { CONFIG_DESPACHO, iniciarDespacho, enviarTanda, validarDependenciasDespacho };
