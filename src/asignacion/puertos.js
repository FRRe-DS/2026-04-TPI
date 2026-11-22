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
//     -> { resultado: asignada | ya_asignada | solicitud_cancelada |
//                     solicitud_no_buscando | solicitud_inexistente }  (ResultadoPuertoAsignacion;
//        el módulo B lo simplifica a solicitud_no_disponible + motivo / no_encontrado)
//     Si ya estaba asignada AL MISMO conductor puede devolver asignada (idempotente).
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
// ofertas.rechazar({ ofertaId, conductorId, ahora }, tx)            (solo lo usa src/respuesta)
//     Igual que aceptar pero deja RECHAZADA. -> { rechazada: boolean }
// ofertas.listarVencidas({ ahora, lote }, tx?)                       (solo lo usa el job de vencimientos)
//     -> [{ ofertaId, solicitudId, conductorId }]  pendientes con venceEn <= ahora
// ofertas.vencer({ ofertaId, ahora }, tx)
//     Condicional: solo si PENDIENTE y venceEn <= ahora. -> { vencida: boolean }
// busquedas.obtenerActiva(solicitudId, tx?)
//     -> { busquedaId, venceEn, candidatosRestantes } | null
// busquedas.cerrar({ solicitudId, estado }, tx)
//     Condicional: solo si estaba ACTIVA. -> boolean (true si la cerró)
// busquedas.adelantarTanda({ solicitudId, ahora }, tx?)               (src/asignacion/busquedaAgotada.js)
//     Condicional: si la búsqueda está ACTIVA y la próxima tanda es futura, la pone en `ahora`. -> boolean
//
// ── Despacho por tandas (src/ofertas) ────────────────────────────────────────
// solicitudes.obtenerDatosViaje(solicitudId, tx?)
//     -> { origen: { latitud, longitud }, destino: { latitud, longitud }, tipoVehiculo } | null
// ofertas.crearTanda({ solicitudId, ofertas: [{ ofertaId, conductorId }], venceEn, ahora }, tx)
//     Crea las ofertas en estado PENDIENTE. -> { creadas: number }
// busquedas.crear({ solicitudId, venceEn, candidatosRestantes, proximaTandaEn }, tx) -> { busquedaId }
// busquedas.reclamarTanda({ solicitudId, ahora, proximaTandaEn }, tx?)
//     Condicional: solo si está ACTIVA y proximaTandaEn <= ahora; la mueve a la nueva fecha. -> boolean
// busquedas.registrarTanda({ solicitudId, candidatosRestantes }, tx?)
// busquedas.listarTandasVencidas({ ahora, lote }, tx?) -> [{ solicitudId }]  ACTIVAS con proximaTandaEn <= ahora
// candidatos.pendientesDeOfertar({ solicitudId, ronda? }, tx?)
//     -> [{ conductorId, distanciaM, tipoVehiculo }] en orden de cercanía; excluye reservados, omitidos y liberados.
// candidatos.marcarOmitidos({ solicitudId, ronda?, conductorIds, ahora }, tx?)
//     M4 informó conflicto: no se les vuelve a ofertar. Condicional: solo los que no estaban reservados.
//
// candidatos (lista que devolvió M4 para la solicitud; M5 reserva en M4 de a un conductor, antes de ofertarle)
// candidatos.guardar({ solicitudId, ronda, lista: [{ conductorId, distanciaM, tipoVehiculo }], ahora }, tx?)
//     Idempotente: repetir la misma (solicitudId, ronda, conductorId) no duplica.        (src/busqueda)
// candidatos.marcarReservado({ solicitudId, ronda?, conductorId, ahora }, tx?)       (src/asignacion/reserva.js)
//     Condicional: solo si todavía no estaba marcado. -> { marcados: number }
// candidatos.pendientesDeLiberar({ solicitudId, exceptoConductorId? }, tx?)
//     -> [conductorId]  de TODAS las rondas, los reservados por M5 que todavía no se liberaron en M4.
// candidatos.marcarLiberados({ solicitudId, conductorIds, ahora }, tx?)
//     Condicional: solo los que seguían sin liberar. -> { marcados: number }
//
// ── Infraestructura ──────────────────────────────────────────────────────────
// ejecutarEnTransaccion(async (tx) => resultado)
//     Confirma si la función termina; deshace y relanza el error si lanza.
// cacheOfertas.eliminar([ofertaId, ...])                       (Redis, RNF-11)
// notificaciones.conductorAsignado({ solicitudId, conductorId, ofertaId })   (M6)
// notificaciones.reservarConductor({ solicitudId, conductorId }) -> boolean  (M4: true reservado, false si hubo conflicto 409)
// notificaciones.liberarConductores([{ solicitudId, conductorId }])  (M4: el mismo aviso "liberado" para todos, sin motivo)
// reloj() -> Date           (opcional; para poder probar vencimientos)
// logger                    (opcional)
//
// ORDEN DE BLOQUEO (evita deadlocks): solicitud -> ofertas -> búsqueda.

const REQUERIDOS = {
  solicitudes: ["obtenerEstado", "asignar", "marcarSinDisponibilidad"],
  ofertas: ["obtenerPorId", "aceptar", "cancelarPendientesDeSolicitud", "contarPendientes"],
  busquedas: ["obtenerActiva", "cerrar", "adelantarTanda"],
  eventos: ["registrar"],
  cacheOfertas: ["eliminar"],
  candidatos: ["pendientesDeLiberar", "marcarLiberados"],
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
