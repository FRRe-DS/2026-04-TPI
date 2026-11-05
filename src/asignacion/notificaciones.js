// Avisos a otros módulos tras una asignación, rechazo, vencimiento o cancelación (M6 y M4).
// Usa clientes con timeout y reintentos limitados (RNF-13) e idempotencia (RNF-09):
// repetir un aviso no puede duplicar efectos en el otro módulo.
//
// Hacia M4 el cuerpo va en snake_case; el resto del código trabaja en camelCase y la traducción
// se hace SOLO acá.
//   Liberar conductor   { conductor_id, solicitud_id }
//                       Es el mismo aviso para todos: M4 no recibe el motivo de la liberación.
// La aceptación de un conductor NO se le avisa a M4 (se da solo a M3).
//
// ATENCIÓN: las rutas NO están inventadas. Hay que acordarlas con los grupos de M4 y M6;
// por eso se pasan por parámetro y no tienen valor por defecto.
//
//   rutas.m6ConductorAsignado({ solicitudId })              -> string
//   rutas.m4LiberarConductor({ conductorId, solicitudId })  -> string

function crearNotificaciones({ clienteM4, clienteM6, rutas, logger }) {
  if (!clienteM4 || !clienteM6) throw new Error("Faltan clienteM4 y/o clienteM6");
  const requeridas = ["m6ConductorAsignado", "m4LiberarConductor"];
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

    // lista: [{ solicitudId, conductorId }]. Devuelve los conductores liberados; si M4 falla con
    // alguno, el error trae en `liberados` los que SÍ salieron.
    async liberarConductores(lista) {
      const resultados = await Promise.allSettled(
        lista.map(async (item) => {
          await clienteM4.post(
            rutas.m4LiberarConductor({ conductorId: item.conductorId, solicitudId: item.solicitudId }),
            { conductor_id: item.conductorId, solicitud_id: item.solicitudId },
            { claveIdempotencia: `liberar:${item.solicitudId}:${item.conductorId}` }
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

module.exports = { crearNotificaciones };
