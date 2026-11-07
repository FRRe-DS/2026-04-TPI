// Avisos a otros módulos: ofertas a M3, y tras una asignación, rechazo, vencimiento o cancelación (M6 y M4).
// Usa clientes con timeout y reintentos limitados (RNF-13) e idempotencia (RNF-09):
// repetir un aviso no puede duplicar efectos en el otro módulo.
//
// Hacia M3 y M4 el cuerpo va en snake_case; el resto del código trabaja en camelCase y la traducción
// se hace SOLO acá.
//   Liberar conductor   { conductor_id, solicitud_id }
//                       Es el mismo aviso para todos: M4 no recibe el motivo de la liberación.
// La aceptación de un conductor NO se le avisa a M4 (se da solo a M3).
//
// Contrato con M3 (envío de ofertas): una llamada por solicitud con todas las ofertas.
//   Enviar ofertas      { solicitud_id, ofertas: [{ oferta_id, conductor_id }],
//                         origen_latitud, origen_longitud, destino_latitud, destino_longitud,
//                         tipo_vehiculo, vence_en (ISO-8601 UTC) }
//   Respuesta de M3: 200. La respuesta del conductor llega a M5 por src/respuesta (POST /ofertas/:ofertaId/respuesta).
//
// ATENCIÓN: las rutas NO están inventadas. Hay que acordarlas con los grupos de M3, M4 y M6;
// por eso se pasan por parámetro y no tienen valor por defecto.
//
//   rutas.m3EnviarOfertas({ solicitudId })                  -> string
//   rutas.m6ConductorAsignado({ solicitudId })              -> string
//   rutas.m4LiberarConductor({ conductorId, solicitudId })  -> string

const { createHash } = require("node:crypto");

function crearNotificaciones({ clienteM3, clienteM4, clienteM6, rutas, logger }) {
  if (!clienteM3 || !clienteM4 || !clienteM6) throw new Error("Faltan clienteM3, clienteM4 y/o clienteM6");
  const requeridas = ["m3EnviarOfertas", "m6ConductorAsignado", "m4LiberarConductor"];
  if (requeridas.some((nombre) => typeof rutas?.[nombre] !== "function")) {
    throw new Error("Faltan las rutas acordadas con M3, M4 y M6");
  }

  return {
    // M3: manda las ofertas a todos los conductores de la ronda, con los datos del viaje.
    // ofertas: [{ ofertaId, conductorId }] · origen/destino: { latitud, longitud } · venceEn: Date o ISO.
    // Repetir el envío es seguro: la clave de idempotencia depende de la solicitud y de las ofertas.
    async enviarOfertas({ solicitudId, ofertas, origen, destino, tipoVehiculo, venceEn }) {
      if (!Array.isArray(ofertas) || ofertas.length === 0) throw new Error("No hay ofertas para enviar a M3");
      const huella = createHash("sha1").update(ofertas.map((o) => o.ofertaId).sort().join(",")).digest("hex").slice(0, 16);
      await clienteM3.post(
        rutas.m3EnviarOfertas({ solicitudId }),
        {
          solicitud_id: solicitudId,
          ofertas: ofertas.map((o) => ({ oferta_id: o.ofertaId, conductor_id: o.conductorId })),
          origen_latitud: origen.latitud,
          origen_longitud: origen.longitud,
          destino_latitud: destino.latitud,
          destino_longitud: destino.longitud,
          tipo_vehiculo: tipoVehiculo,
          vence_en: new Date(venceEn).toISOString(),
        },
        { claveIdempotencia: `ofertas:${solicitudId}:${huella}` }
      );
    },

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
