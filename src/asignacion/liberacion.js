// Liberación de conductores en M4 (contrato: docs/contrato-interno-m5.md, sección 7).
//
// M5 reserva en M4 de a un conductor antes de ofertarle (src/asignacion/reserva.js). Solo se libera a los
// que M5 reservó. Un conductor sale de la reserva por una de estas vías, y NUNCA se libera dos veces:
//   - oferta_rechazada / oferta_vencida: apenas ocurre (src/respuesta).
//   - al cerrar la solicitud (asignación, cancelación del cliente, búsqueda agotada): se libera a TODOS
//     los reservados que no hayan salido ya, con o sin oferta, INCLUIDO el ganador: el cambio de libre a
//     ocupado del conductor lo gestionan M3 y M4 entre ellos, M5 solo cierra la reserva temporal.
//   - la razón no se informa: M4 recibe el mismo aviso siempre.
//
// Para saber quién ya salió se usa el puerto `candidatos` (liberadoEn). Se marca DESPUÉS de que M4
// confirma, así un fallo de M4 deja al conductor pendiente en vez de darlo por liberado.

// Libera `items` en M4 y marca como liberados a los que M4 confirmó. Si M4 falló con alguno,
// marca igual a los que sí salieron y vuelve a lanzar el error (queda como aviso fallido).
// items: [{ solicitudId, conductorId }]. M4 recibe el mismo aviso "liberado" siempre, sin motivo.
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

// Al cerrar la solicitud: libera a todos los candidatos reservados por M5 que sigan sin liberar (también al ganador).
// `conOferta` son las ofertas que se acaban de cancelar ([{ conductorId, ofertaId }]); se incluyen
// aunque la lista no se hubiera guardado.
async function liberarCandidatosPendientes({ solicitudId, conOferta = [] }, deps) {
  const pendientes = await deps.candidatos.pendientesDeLiberar({ solicitudId });
  const conductores = new Set([...pendientes, ...conOferta.map((c) => c.conductorId)]);
  const items = [...conductores].map((conductorId) => ({ solicitudId, conductorId }));
  await liberarYMarcar({ solicitudId, items }, deps);
  return items.map((i) => i.conductorId);
}

module.exports = { liberarYMarcar, liberarCandidatosPendientes };
