// Reacción de B cuando A cancela una solicitud (RF-5.7, RNF-08):
// anula las ofertas pendientes, cierra la búsqueda y libera a los conductores.
//
// La carrera "conductor acepta" contra "cliente cancela" NO se resuelve acá: la decide
// la escritura condicional de A (BUSCANDO -> CANCELADA frente a BUSCANDO -> ASIGNADA).
// A llama a esta función DESPUÉS de confirmar su cancelación. Como el estado de la
// solicitud ya es CANCELADA, ningún conductor puede ganar mientras estas ofertas se cierran.
const { validarDependencias } = require("./puertos");
const { conReintentoPorDeadlock, conTimeout } = require("./transacciones");
const { EstadoBusqueda, TipoEvento } = require("../comun/estados");

async function procesarCancelacionSolicitud({ solicitudId, motivo = "CANCELADA_POR_CLIENTE" }, deps) {
  validarDependencias(deps);
  const reloj = deps.reloj ?? (() => new Date());
  const ahora = reloj();

  const canceladas = await conReintentoPorDeadlock(() =>
    deps.ejecutarEnTransaccion(async (tx) => {
      const cerradas = await deps.ofertas.cancelarPendientesDeSolicitud({ solicitudId }, tx);
      await deps.busquedas.cerrar({ solicitudId, estado: EstadoBusqueda.FINALIZADA }, tx);
      for (const c of cerradas) {
        await deps.eventos.registrar(
          {
            solicitudId,
            tipo: TipoEvento.CANCELACION,
            conductorId: c.conductorId,
            ofertaId: c.ofertaId,
            ocurridoEn: ahora,
            detalle: motivo,
          },
          tx
        );
      }
      return cerradas;
    })
  );

  const avisosFallidos = [];
  const intentar = async (nombre, fn) => {
    try {
      await conTimeout(Promise.resolve().then(fn), deps.timeoutAvisosMs ?? 3000);
    } catch (error) {
      avisosFallidos.push(nombre);
      deps.logger?.error({ err: error, solicitudId, aviso: nombre }, "falló un aviso de cancelación");
    }
  };

  if (canceladas.length > 0) {
    await intentar("cacheOfertas", () => deps.cacheOfertas.eliminar(canceladas.map((c) => c.ofertaId)));
    await intentar("liberarConductores", () =>
      deps.notificaciones.liberarConductores(
        canceladas.map((c) => ({
          solicitudId,
          conductorId: c.conductorId,
          ofertaId: c.ofertaId,
          motivo,
        }))
      )
    );
  }
  return { solicitudId, ofertasCanceladas: canceladas.map((c) => c.ofertaId), avisosFallidos };
}

module.exports = { procesarCancelacionSolicitud };
