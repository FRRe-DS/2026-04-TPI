// Avisos a otros módulos tras una asignación o cancelación (M6 y M4).
// Usa clientes con timeout y reintentos limitados (RNF-13) e idempotencia (RNF-09):
// repetir un aviso no puede duplicar efectos en el otro módulo.
//
// ATENCIÓN: las rutas NO están inventadas. Hay que acordarlas con los grupos de M4 y M6;
// por eso se pasan por parámetro y no tienen valor por defecto.
//
//   rutas.m6ConductorAsignado({ solicitudId })  -> string   (ej.: ruta en M6)
//   rutas.m4LiberarConductor({ conductorId })   -> string   (ej.: ruta en M4)
function crearNotificaciones({ clienteM4, clienteM6, rutas, logger }) {
  if (!clienteM4 || !clienteM6) throw new Error("Faltan clienteM4 y/o clienteM6");
  if (typeof rutas?.m6ConductorAsignado !== "function" || typeof rutas?.m4LiberarConductor !== "function") {
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

    async liberarConductores(lista) {
      const resultados = await Promise.allSettled(
        lista.map((item) =>
          clienteM4.post(
            rutas.m4LiberarConductor({ conductorId: item.conductorId }),
            { solicitudId: item.solicitudId, ofertaId: item.ofertaId, motivo: item.motivo },
            { claveIdempotencia: `liberar:${item.ofertaId}` }
          )
        )
      );
      const fallidos = resultados.filter((r) => r.status === "rejected");
      if (fallidos.length > 0) {
        logger?.error({ fallidos: fallidos.length, total: lista.length }, "no se pudo liberar a algunos conductores en M4");
        throw new Error(`No se pudo liberar a ${fallidos.length} de ${lista.length} conductores`);
      }
    },
  };
}

module.exports = { crearNotificaciones };
