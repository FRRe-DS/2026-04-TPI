// Avisos a otros módulos tras una asignación, rechazo, vencimiento o cancelación (M6 y M4).
// Usa clientes con timeout y reintentos limitados (RNF-13) e idempotencia (RNF-09):
// repetir un aviso no puede duplicar efectos en el otro módulo.
//
// Contrato con M4 (docs/contrato-interno-m5.md, sección 7). Hacia M4 el cuerpo va en snake_case;
// el resto del código trabaja en camelCase y la traducción se hace SOLO acá.
//   Liberar conductor       { conductor_id, solicitud_id, oferta_id, motivo }
//                           (oferta_id es null para un candidato que nunca recibió oferta)
//   Conductor seleccionado  { solicitud_id, conductor_id, oferta_id }
//
// ATENCIÓN: las rutas NO están inventadas. Hay que acordarlas con los grupos de M4 y M6;
// por eso se pasan por parámetro y no tienen valor por defecto.
//
//   rutas.m6ConductorAsignado({ solicitudId })              -> string
//   rutas.m4LiberarConductor({ conductorId, solicitudId })  -> string
//   rutas.m4ConductorSeleccionado({ solicitudId })          -> string

// Motivos que M4 acepta al liberar a un conductor (valores tal cual viajan).
const MotivoLiberacion = Object.freeze({
  OFERTA_RECHAZADA: "oferta_rechazada", // el conductor rechazó
  OFERTA_VENCIDA: "oferta_vencida", // el conductor no respondió a tiempo
  SOLICITUD_CERRADA: "solicitud_cerrada", // otro conductor ganó la solicitud
  CANCELADA_POR_CLIENTE: "cancelada_por_cliente", // el cliente canceló
});

const MOTIVOS_VALIDOS = new Set(Object.values(MotivoLiberacion));

function crearNotificaciones({ clienteM4, clienteM6, rutas, logger }) {
  if (!clienteM4 || !clienteM6) throw new Error("Faltan clienteM4 y/o clienteM6");
  const requeridas = ["m6ConductorAsignado", "m4LiberarConductor", "m4ConductorSeleccionado"];
  if (requeridas.some((nombre) => typeof rutas?.[nombre] !== "function")) {
    throw new Error("Faltan las rutas acordadas con M4 y M6");
  }

  return {
    async conductorAsignado({ solicitudId, conductorId, ofertaId }) {
      await clienteM6.post(
        rutas.m6ConductorAsignado({ solicitudId }),
        { solicitudId, conductorId, ofertaId },
        { claveIdempotencia: `asignacion:${solicitudId}:${ofertaId}` }
      );
    },

    // M4: el ganador pasa de "reservado" a "ocupado". Se manda una sola vez, tras confirmar.
    // M4 puede responder 4xx si el conductor ya no está disponible: llega acá como error y
    // el caso de uso lo informa en `avisosFallidos` (la asignación ya está confirmada).
    async conductorSeleccionado({ solicitudId, conductorId, ofertaId }) {
      await clienteM4.post(
        rutas.m4ConductorSeleccionado({ solicitudId }),
        { solicitud_id: solicitudId, conductor_id: conductorId, oferta_id: ofertaId },
        { claveIdempotencia: `seleccion:${solicitudId}:${conductorId}` }
      );
    },

    async liberarConductores(lista) {
      const resultados = await Promise.allSettled(
        lista.map(async (item) => {
          if (!MOTIVOS_VALIDOS.has(item.motivo)) {
            throw new Error(`Motivo de liberación inválido: ${item.motivo}`);
          }
          await clienteM4.post(
            rutas.m4LiberarConductor({ conductorId: item.conductorId, solicitudId: item.solicitudId }),
            {
              conductor_id: item.conductorId,
              solicitud_id: item.solicitudId,
              oferta_id: item.ofertaId ?? null,
              motivo: item.motivo,
            },
            {
              // Con oferta la clave es por oferta; sin oferta (candidato que nunca la recibió), por solicitud y conductor.
              claveIdempotencia: item.ofertaId
                ? `liberar:${item.ofertaId}`
                : `liberar:${item.solicitudId}:${item.conductorId}`,
            }
          );
          return item.conductorId;
        })
      );
      const liberados = resultados.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const fallidos = resultados.filter((r) => r.status === "rejected");
      if (fallidos.length > 0) {
        logger?.error({ fallidos: fallidos.length, total: lista.length }, "no se pudo liberar a algunos conductores en M4");
        const error = new Error(`No se pudo liberar a ${fallidos.length} de ${lista.length} conductores`);
        error.liberados = liberados; // los que SÍ se liberaron: quien llama los marca para no repetirlos
        throw error;
      }
      return liberados;
    },
  };
}

module.exports = { crearNotificaciones, MotivoLiberacion };
