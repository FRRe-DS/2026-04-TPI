// Liberación de conductores en M4 (contrato: docs/contrato-interno-m5.md, sección 7).
//
// M4 reserva a TODOS los conductores que devuelve en la lista. Un conductor sale de la reserva por
// una de estas vías, y NUNCA se libera dos veces:
//   - oferta_rechazada / oferta_vencida: apenas ocurre (src/respuesta).
//   - al cerrar la solicitud (otro ganó, cancelación del cliente, búsqueda agotada): se libera a TODOS
//     los de la lista que no hayan salido ya, con o sin oferta, menos al ganador.
//
// Para saber quién ya salió se usa el puerto `candidatos` (liberadoEn). Se marca DESPUÉS de que M4
// confirma, así un fallo de M4 deja al conductor pendiente en vez de darlo por liberado.
const { MotivoLiberacion } = require("./notificaciones");

// Libera `items` en M4 y marca como liberados a los que M4 confirmó. Si M4 falló con alguno,
// marca igual a los que sí salieron y vuelve a lanzar el error (queda como aviso fallido).
// items: [{ solicitudId, conductorId, ofertaId|null, motivo }]
async function liberarYMarcar({ solicitudId, items }, deps) {
  if (items.length === 0) return;
  const ahora = (deps.reloj ?? (() => new Date()))();
  let liberados = [];
  let errorLiberacion = null;
  try {
    liberados = (await deps.notificaciones.liberarConductores(items)) ?? items.map((i) => i.conductorId);
  } catch (error) {
    errorLiberacion = error;
    liberados = error.liberados ?? [];
  }
  if (liberados.length > 0) {
    await deps.candidatos.marcarLiberados({ solicitudId, conductorIds: liberados, ahora });
  }
  if (errorLiberacion) throw errorLiberacion;
}

// Al cerrar la solicitud: libera a todos los candidatos que sigan reservados, menos al ganador.
// `conOferta` son las ofertas que se acaban de cancelar ([{ conductorId, ofertaId }]); se incluyen
// aunque la lista no se hubiera guardado, y le dan su oferta_id al aviso.
async function liberarCandidatosPendientes({ solicitudId, ganadorId, motivo, conOferta = [] }, deps) {
  const pendientes = await deps.candidatos.pendientesDeLiberar({
    solicitudId,
    ...(ganadorId ? { exceptoConductorId: ganadorId } : {}),
  });
  const ofertaPorConductor = new Map(conOferta.map((c) => [c.conductorId, c.ofertaId]));
  const conductores = new Set([...pendientes, ...ofertaPorConductor.keys()]);
  if (ganadorId) conductores.delete(ganadorId);
  const items = [...conductores].map((conductorId) => ({
    solicitudId,
    conductorId,
    ofertaId: ofertaPorConductor.get(conductorId) ?? null,
    motivo,
  }));
  await liberarYMarcar({ solicitudId, items }, deps);
  return items.map((i) => i.conductorId);
}

module.exports = { liberarYMarcar, liberarCandidatosPendientes };
