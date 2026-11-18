// Reserva en M4 (bloqueo temporal) de los conductores a los que se les va a mandar oferta.
//
// M4 NO bloquea la lista que devuelve: M5 pide la reserva de a UN conductor, en orden de cercanía,
// y recién con la reserva hecha le manda la oferta por M3.
//   - reservado   -> se marca (candidatos.marcarReservado) y ya se le puede ofertar.
//   - conflicto   -> otra solicitud lo reservó antes (409): se salta al siguiente.
//   - fallo de M4 -> se salta y se informa en `fallidos`. Si M4 alcanzó a reservarlo, su TTL de
//                    10 minutos lo libera solo.
//
// Después se libera SOLO a los que quedaron marcados acá (src/asignacion/liberacion.js): M4 libera por
// conductor_id, así que liberar a uno que reservó otra solicitud le sacaría el bloqueo a esa solicitud.
//
// La lista de candidatos debe estar guardada antes (candidatos.guardar), porque se marca sobre esas filas.
//
// candidatos: [{ conductorId, ... }] en el orden en que se quiere ofertar (el más cercano primero).
// cantidad:   cuántos conductores hacen falta; se deja de reservar al llegar a ese número.
// Devuelve { reservados: [candidato], conflictos: [conductorId], fallidos: [conductorId] }.
async function reservarConductores({ solicitudId, candidatos, cantidad = Infinity, ronda = 1 }, deps) {
  const ahora = (deps.reloj ?? (() => new Date()))();
  const reservados = [];
  const conflictos = [];
  const fallidos = [];

  for (const candidato of candidatos) {
    if (reservados.length >= cantidad) break;
    let reservado;
    try {
      reservado = await deps.notificaciones.reservarConductor({ solicitudId, conductorId: candidato.conductorId });
    } catch (error) {
      deps.logger?.error({ solicitudId, conductorId: candidato.conductorId, err: error.message }, "no se pudo reservar al conductor en M4");
      fallidos.push(candidato.conductorId);
      continue;
    }
    if (!reservado) {
      conflictos.push(candidato.conductorId);
      continue;
    }
    const { marcados } = await deps.candidatos.marcarReservado({ solicitudId, ronda, conductorId: candidato.conductorId, ahora });
    if (marcados === 0) {
      deps.logger?.warn({ solicitudId, conductorId: candidato.conductorId }, "reservado en M4 pero no figura en la lista guardada: no se liberará solo");
    }
    reservados.push(candidato);
  }
  return { reservados, conflictos, fallidos };
}

module.exports = { reservarConductores };
