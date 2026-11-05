// Rechazo de una oferta por parte del conductor (RF-5.5) con idempotencia (RNF-09).
//
// Misma receta que la aceptación (src/asignacion/procesarAceptacion.js):
//   1. Pre-validación fuera de la transacción: existe y es de ese conductor.
//   2. UNA transacción: evento RECHAZO + escritura condicional de la oferta.
//      El evento se registra ANTES de cambiar la oferta (orden de bloqueos: primero lo que
//      toca la solicitud, después la oferta, igual que la asignación).
//      Si la escritura no cambió ninguna fila -> RevertirTransaccion: el evento se deshace.
//   3. Después del commit: avisos (caché, M4) y evaluación de búsqueda agotada.
//      Si algo de esto falla, el rechazo YA está guardado: se informa en `avisosFallidos`.
const { EstadoOferta, TipoEvento } = require("../comun/estados");
const { liberarYMarcar } = require("../asignacion/liberacion");
const {
  RevertirTransaccion,
  conReintentoPorDeadlock,
  conTimeout,
  evaluarBusquedaAgotada,
  validarDependencias,
} = require("../asignacion");
const { ResultadoRespuesta } = require("./resultadosRespuesta");
const {
  ResultadoAsignacion: R,
  MotivoNoDisponible: Motivo,
  noDisponible,
} = require("../asignacion/resultados");

async function procesarRechazo({ ofertaId, conductorId }, deps) {
  validarDependencias(deps);
  if (typeof deps.ofertas.rechazar !== "function") {
    throw new Error("Faltan dependencias para el rechazo: ofertas.rechazar");
  }
  const ahora = (deps.reloj ?? (() => new Date()))();

  // 1) Pre-validación (solo lectura).
  const oferta = await deps.ofertas.obtenerPorId(ofertaId);
  if (!oferta) return { resultado: R.NO_ENCONTRADO };
  if (oferta.conductorId !== conductorId) return { resultado: R.CONDUCTOR_NO_AUTORIZADO };
  const { solicitudId } = oferta;

  // 2) Transacción.
  const rechazada = await conReintentoPorDeadlock(() =>
    deps
      .ejecutarEnTransaccion(async (tx) => {
        await deps.eventos.registrar(
          { solicitudId, tipo: TipoEvento.RECHAZO, conductorId, ofertaId, ocurridoEn: ahora },
          tx
        );
        const r = await deps.ofertas.rechazar({ ofertaId, conductorId, ahora }, tx);
        if (!r.rechazada) throw new RevertirTransaccion("NO_RECHAZADA");
        return true;
      })
      .catch((error) => {
        if (error instanceof RevertirTransaccion) return false;
        throw error;
      })
  );

  // No se pudo rechazar: o ya estaba rechazada (repetición), o ya no se puede.
  if (!rechazada) {
    const actual = await deps.ofertas.obtenerPorId(ofertaId);
    if (!actual) return { resultado: R.NO_ENCONTRADO };
    if (actual.estado === EstadoOferta.RECHAZADA) {
      return { resultado: ResultadoRespuesta.RECHAZADA, solicitudId, repetida: true };
    }
    if (actual.estado === EstadoOferta.ACEPTADA) {
      return noDisponible(Motivo.YA_ACEPTADA, { solicitudId });
    }
    return { resultado: R.OFERTA_NO_VIGENTE, solicitudId }; // vencida, cancelada o pasada de hora
  }

  // 3) Después del commit.
  const avisosFallidos = [];
  const intentar = async (nombre, fn) => {
    try {
      await conTimeout(Promise.resolve().then(fn), deps.timeoutAvisosMs ?? 3000);
    } catch (error) {
      avisosFallidos.push(nombre);
      deps.logger?.error({ err: error, solicitudId, aviso: nombre }, "falló un aviso del rechazo");
    }
  };
  await intentar("cacheOfertas", () => deps.cacheOfertas.eliminar([ofertaId]));
  // Sale de la reserva ahora; queda marcado para que el cierre de la solicitud no lo libere otra vez.
  await intentar("liberarConductores", () =>
    liberarYMarcar(
      {
        solicitudId,
        items: [{ solicitudId, conductorId }],
      },
      deps
    )
  );

  let busquedaAgotada = false;
  await intentar("busquedaAgotada", async () => {
    busquedaAgotada = (await evaluarBusquedaAgotada({ solicitudId }, deps)).agotada;
  });

  return {
    resultado: ResultadoRespuesta.RECHAZADA,
    solicitudId,
    repetida: false,
    busquedaAgotada,
    avisosFallidos,
  };
}

module.exports = { procesarRechazo };
