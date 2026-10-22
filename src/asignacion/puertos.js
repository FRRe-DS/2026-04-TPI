// PUERTOS (interfaces) que el orquestador de asignación necesita de los demás.
// Cada subequipo implementa los suyos; acá solo se documenta la forma y se valida
// al arrancar que estén todos conectados.
//
// Convención: `tx` es el cliente de la transacción abierta (en Prisma, el `tx` de
// prisma.$transaction). Si se omite, la operación corre fuera de transacción.
//
// ── Equipo A (src/solicitudes) ───────────────────────────────────────────────
// solicitudes.obtenerEstado(solicitudId, tx?)
//     -> { estado, conductorAsignadoId } | null
// solicitudes.asignar({ solicitudId, conductorId }, tx)
//     Escritura CONDICIONAL: pasa a ASIGNADA solo si estado = BUSCANDO.
//     -> { resultado: ASIGNADA | YA_ASIGNADA | SOLICITUD_CANCELADA |
//                     SOLICITUD_NO_BUSCANDO | SOLICITUD_INEXISTENTE }
//     Si ya estaba asignada AL MISMO conductor puede devolver ASIGNADA (idempotente).
// solicitudes.marcarSinDisponibilidad({ solicitudId, motivo }, tx)
//     Condicional: solo si estado = BUSCANDO.
//     -> { aplicado: boolean, estadoActual }
// eventos.registrar({ solicitudId, tipo, conductorId?, ofertaId?, ocurridoEn, detalle? }, tx)
//
// ── Equipo B (src/ofertas, src/busqueda) ─────────────────────────────────────
// ofertas.obtenerPorId(ofertaId, tx?)
//     -> { ofertaId, solicitudId, conductorId, estado, venceEn } | null
// ofertas.aceptar({ ofertaId, conductorId, ahora }, tx)
//     Condicional: solo si PENDIENTE, vigente (venceEn > ahora) y del conductor.
//     -> { aceptada: boolean }
// ofertas.cancelarPendientesDeSolicitud({ solicitudId, exceptoOfertaId? }, tx)
//     -> [{ ofertaId, conductorId }]   (las que efectivamente canceló)
// ofertas.contarPendientes(solicitudId, tx?) -> number
// busquedas.obtenerActiva(solicitudId, tx?)
//     -> { busquedaId, venceEn, candidatosRestantes } | null
// busquedas.cerrar({ solicitudId, estado }, tx)
//     Condicional: solo si estaba ACTIVA. -> boolean (true si la cerró)
//
// ── Infraestructura ──────────────────────────────────────────────────────────
// ejecutarEnTransaccion(async (tx) => resultado)
//     Confirma si la función termina; deshace y relanza el error si lanza.
// cacheOfertas.eliminar([ofertaId, ...])                       (Redis, RNF-11)
// notificaciones.conductorAsignado({ solicitudId, conductorId, ofertaId })   (M6)
// notificaciones.liberarConductores([{ solicitudId, conductorId, ofertaId, motivo }])  (M4)
// reloj() -> Date           (opcional; para poder probar vencimientos)
// logger                    (opcional)
//
// ORDEN DE BLOQUEO (evita deadlocks): solicitud -> ofertas -> búsqueda.

const REQUERIDOS = {
  solicitudes: ["obtenerEstado", "asignar", "marcarSinDisponibilidad"],
  ofertas: ["obtenerPorId", "aceptar", "cancelarPendientesDeSolicitud", "contarPendientes"],
  busquedas: ["obtenerActiva", "cerrar"],
  eventos: ["registrar"],
  cacheOfertas: ["eliminar"],
  notificaciones: ["conductorAsignado", "liberarConductores"],
};

function validarDependencias(deps) {
  const faltantes = [];
  if (typeof deps?.ejecutarEnTransaccion !== "function") faltantes.push("ejecutarEnTransaccion");
  for (const [puerto, metodos] of Object.entries(REQUERIDOS)) {
    for (const metodo of metodos) {
      if (typeof deps?.[puerto]?.[metodo] !== "function") faltantes.push(`${puerto}.${metodo}`);
    }
  }
  if (faltantes.length > 0) {
    throw new Error("Faltan dependencias para la asignación: " + faltantes.join(", "));
  }
}

module.exports = { REQUERIDOS, validarDependencias };
