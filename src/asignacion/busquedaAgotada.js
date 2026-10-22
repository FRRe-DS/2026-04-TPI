// Detección de "búsqueda agotada" y señal hacia A (RF-5.8).
const { validarDependencias } = require("./puertos");
const { conReintentoPorDeadlock } = require("./transacciones");
const { EstadoBusqueda, TipoEvento } = require("../comun/estados");

// Regla pura (se prueba sin base de datos): la búsqueda está agotada cuando NO queda
// ninguna oferta pendiente Y (no quedan candidatos sin ofertar O ya pasó la fecha límite).
function estaAgotada({ ofertasPendientes, candidatosRestantes, venceEn, ahora }) {
  if (ofertasPendientes > 0) return false;
  return candidatosRestantes === 0 || new Date(ahora) >= new Date(venceEn);
}

// Cierra la búsqueda como AGOTADA y le avisa a A. Es segura de llamar varias veces o en
// paralelo: la señal sale UNA sola vez porque A solo aplica el cambio si la solicitud sigue
// en BUSCANDO. Orden de bloqueo: solicitud primero, búsqueda después.
async function procesarBusquedaAgotada({ solicitudId, motivo }, deps) {
  validarDependencias(deps);
  const reloj = deps.reloj ?? (() => new Date());
  const ahora = reloj();

  return conReintentoPorDeadlock(() =>
    deps.ejecutarEnTransaccion(async (tx) => {
      const r = await deps.solicitudes.marcarSinDisponibilidad({ solicitudId, motivo }, tx);
      if (!r.aplicado) {
        // Ya estaba asignada, cancelada o marcada: no hay nada que señalar.
        return { senalEnviada: false, estadoSolicitud: r.estadoActual, motivo };
      }
      await deps.busquedas.cerrar({ solicitudId, estado: EstadoBusqueda.AGOTADA }, tx);
      await deps.eventos.registrar(
        {
          solicitudId,
          tipo: TipoEvento.BUSQUEDA,
          ocurridoEn: ahora,
          detalle: `Búsqueda agotada: ${motivo}`,
        },
        tx
      );
      return { senalEnviada: true, estadoSolicitud: r.estadoActual, motivo };
    })
  );
}

// Lo llama quien cierra una ronda de ofertas (rechazo, vencimiento, sin candidatos).
async function evaluarBusquedaAgotada({ solicitudId }, deps) {
  validarDependencias(deps);
  const reloj = deps.reloj ?? (() => new Date());
  const ahora = reloj();

  const busqueda = await deps.busquedas.obtenerActiva(solicitudId);
  if (!busqueda) return { agotada: false, senalEnviada: false, motivo: "SIN_BUSQUEDA_ACTIVA" };

  const ofertasPendientes = await deps.ofertas.contarPendientes(solicitudId);
  const agotada = estaAgotada({
    ofertasPendientes,
    candidatosRestantes: busqueda.candidatosRestantes,
    venceEn: busqueda.venceEn,
    ahora,
  });
  if (!agotada) return { agotada: false, senalEnviada: false };

  const motivo = busqueda.candidatosRestantes === 0 ? "SIN_CANDIDATOS" : "PERIODO_VENCIDO";
  const resultado = await procesarBusquedaAgotada({ solicitudId, motivo }, deps);
  return { agotada: true, ...resultado };
}

module.exports = { estaAgotada, procesarBusquedaAgotada, evaluarBusquedaAgotada };
