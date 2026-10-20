// Asignación única (RF-5.6) con escrituras condicionales (RNF-08) e idempotencia (RNF-09).
//
// IDEA CLAVE: el ganador lo decide la base de datos con una escritura condicional
// ("pasar a ASIGNADA solo si sigue en BUSCANDO"), no un "leer y después escribir".
// Todo el cambio (solicitud + oferta + ofertas hermanas + búsqueda + eventos) va en
// UNA transacción: si algo falla o perdemos la carrera, se deshace completo.
// Los avisos externos (Redis, M4, M6) se hacen DESPUÉS de confirmar, nunca adentro.
const { ResultadoAsignacion: R } = require("./resultados");
const { validarDependencias } = require("./puertos");
const { RevertirTransaccion, conReintentoPorDeadlock, conTimeout } = require("./transacciones");
const {
  EstadoSolicitud,
  EstadoOferta,
  EstadoBusqueda,
  TipoEvento,
} = require("../comun/estados");

const TIMEOUT_AVISOS_MS = 3000;

function ofertaVigente(oferta, ahora) {
  return oferta.estado === EstadoOferta.PENDIENTE && new Date(oferta.venceEn) > ahora;
}

// Si la oferta no sirve, le explicamos al conductor POR QUÉ mirando la solicitud.
async function explicarOfertaNoVigente(solicitudId, deps) {
  const solicitud = await deps.solicitudes.obtenerEstado(solicitudId);
  if (solicitud?.estado === EstadoSolicitud.ASIGNADA) return R.YA_ASIGNADA;
  if (solicitud?.estado === EstadoSolicitud.CANCELADA) return R.SOLICITUD_CANCELADA;
  return R.OFERTA_NO_VIGENTE;
}

// Caso "repetición": el MISMO conductor ya ganó (reintento o doble clic). Devolvemos
// el mismo éxito sin repetir efectos ni avisos. Si no, devolvemos el resultado original.
async function resolverRepeticion({ ofertaId, conductorId, solicitudId, resultadoOriginal }, deps) {
  const oferta = await deps.ofertas.obtenerPorId(ofertaId);
  if (oferta && oferta.estado === EstadoOferta.ACEPTADA && oferta.conductorId === conductorId) {
    const solicitud = await deps.solicitudes.obtenerEstado(solicitudId);
    if (
      solicitud &&
      solicitud.estado === EstadoSolicitud.ASIGNADA &&
      solicitud.conductorAsignadoId === conductorId
    ) {
      return { resultado: R.ASIGNADA, solicitudId, conductorId, ofertaId, repetida: true };
    }
  }
  return { resultado: resultadoOriginal, solicitudId };
}

async function procesarAceptacion({ ofertaId, conductorId }, deps) {
  validarDependencias(deps);
  const { ofertas, solicitudes, busquedas, eventos, ejecutarEnTransaccion } = deps;
  const reloj = deps.reloj ?? (() => new Date());
  const ahora = reloj();

  // 1) Pre-validación barata, SIN transacción ni bloqueos: descarta lo evidente.
  const oferta = await ofertas.obtenerPorId(ofertaId);
  if (!oferta) return { resultado: R.OFERTA_INEXISTENTE };
  if (oferta.conductorId !== conductorId) return { resultado: R.CONDUCTOR_NO_AUTORIZADO };
  const solicitudId = oferta.solicitudId;

  if (oferta.estado === EstadoOferta.ACEPTADA) {
    return resolverRepeticion(
      { ofertaId, conductorId, solicitudId, resultadoOriginal: R.YA_ASIGNADA },
      deps
    );
  }
  if (!ofertaVigente(oferta, ahora)) {
    return { resultado: await explicarOfertaNoVigente(solicitudId, deps), solicitudId };
  }

  // 2) Transacción. Orden de bloqueo: solicitud -> ofertas -> búsqueda.
  let canceladas;
  try {
    canceladas = await conReintentoPorDeadlock(() =>
      ejecutarEnTransaccion(async (tx) => {
        // 2.a) La carrera se decide acá: escritura condicional sobre la solicitud (A).
        const asignacion = await solicitudes.asignar({ solicitudId, conductorId }, tx);
        if (asignacion.resultado !== R.ASIGNADA) {
          throw new RevertirTransaccion(asignacion.resultado);
        }

        // 2.b) Aceptamos la oferta (condicional). Si venció justo ahora, se DESHACE
        //      también la asignación: por eso todo va en la misma transacción.
        const { aceptada } = await ofertas.aceptar({ ofertaId, conductorId, ahora }, tx);
        if (!aceptada) throw new RevertirTransaccion(R.OFERTA_NO_VIGENTE);

        // 2.c) Las demás ofertas de esta solicitud ya no tienen sentido.
        const hermanas = await ofertas.cancelarPendientesDeSolicitud(
          { solicitudId, exceptoOfertaId: ofertaId },
          tx
        );

        // 2.d) Cerramos la búsqueda y dejamos la trazabilidad (RF-5.9).
        await busquedas.cerrar({ solicitudId, estado: EstadoBusqueda.FINALIZADA }, tx);
        await eventos.registrar(
          { solicitudId, tipo: TipoEvento.ACEPTACION, conductorId, ofertaId, ocurridoEn: ahora },
          tx
        );
        for (const h of hermanas) {
          await eventos.registrar(
            {
              solicitudId,
              tipo: TipoEvento.CANCELACION,
              conductorId: h.conductorId,
              ofertaId: h.ofertaId,
              ocurridoEn: ahora,
              detalle: "Otra oferta fue aceptada",
            },
            tx
          );
        }
        return hermanas;
      })
    );
  } catch (error) {
    if (error instanceof RevertirTransaccion) {
      // Perdimos la carrera o venció la oferta. Antes de informar "perdiste", revisamos
      // si en realidad es el MISMO conductor repitiendo un pedido que ya había ganado.
      return resolverRepeticion(
        { ofertaId, conductorId, solicitudId, resultadoOriginal: error.resultado },
        deps
      );
    }
    throw error;
  }

  // 3) Ya está confirmado. Avisos externos: un fallo acá NO deshace la asignación;
  //    se informa en `avisosFallidos` para reintentarlos.
  const avisosFallidos = [];
  const intentar = async (nombre, fn) => {
    try {
      await conTimeout(Promise.resolve().then(fn), deps.timeoutAvisosMs ?? TIMEOUT_AVISOS_MS);
    } catch (error) {
      avisosFallidos.push(nombre);
      deps.logger?.error({ err: error, solicitudId, aviso: nombre }, "falló un aviso post-asignación");
    }
  };

  await intentar("cacheOfertas", () =>
    deps.cacheOfertas.eliminar([ofertaId, ...canceladas.map((c) => c.ofertaId)])
  );
  await intentar("conductorAsignado", () =>
    deps.notificaciones.conductorAsignado({ solicitudId, conductorId, ofertaId })
  );
  if (canceladas.length > 0) {
    await intentar("liberarConductores", () =>
      deps.notificaciones.liberarConductores(
        canceladas.map((c) => ({
          solicitudId,
          conductorId: c.conductorId,
          ofertaId: c.ofertaId,
          motivo: "OFERTA_PERDIDA",
        }))
      )
    );
  }

  return {
    resultado: R.ASIGNADA,
    solicitudId,
    conductorId,
    ofertaId,
    repetida: false,
    ofertasCanceladas: canceladas.map((c) => c.ofertaId),
    avisosFallidos,
  };
}

module.exports = { procesarAceptacion };
