// Avisos a otros módulos: ofertas a M3, y tras una asignación, rechazo, vencimiento o cancelación (M6 y M4).
// Usa clientes con timeout y reintentos limitados (RNF-13) e idempotencia (RNF-09):
// repetir un aviso no puede duplicar efectos en el otro módulo.
//
// Hacia M3 y M4 el cuerpo va en snake_case; el resto del código trabaja en camelCase y la traducción
// se hace SOLO acá.
//   Reservar conductor  { estado_temporal: "RESERVADO", solicitud_id }
//                       Bloqueo temporal en M4, de a UN conductor por llamada y ANTES de mandarle la
//                       oferta por M3. Si otra solicitud lo reservó un instante antes, M4 responde 409
//                       y se pasa al siguiente de la lista.
//   Liberar conductor   { estado_temporal: "LIBERADO", solicitud_id }
//                       Es el mismo aviso para todos, sin importar la razón, de a un conductor por
//                       llamada: M4 no recibe el motivo ni la solicitud.
// A M4 no se le avisa la aceptación del conductor (eso es solo con M3), pero al cerrar la solicitud se
// libera la reserva temporal de todos, también la del ganador: pasar al conductor de libre a ocupado
// lo gestionan M3 y M4 entre ellos.
//
// M3 recibe una oferta por solicitud POST /api/v1/integration/m5/offers.
// Sus campos de dirección contienen las coordenadas que M5 recibió del mapa.
//
// ATENCIÓN: las rutas NO están inventadas. Hay que acordarlas con los grupos de M3, M4 y M6;
// por eso se pasan por parámetro y no tienen valor por defecto.
//
//   rutas.m3EnviarOfertas()                                 -> string
//   rutas.m6ConductorAsignado()                             -> string
//   rutas.m4ReservarConductor({ conductorId })              -> string
//   rutas.m4LiberarConductor({ conductorId })               -> string

const { createHash } = require("node:crypto");

function crearNotificaciones({ clienteM3, clienteM4, clienteM6, rutas, logger, obtenerVehiculoConductor, solicitudes }) {
  if (!clienteM3 || !clienteM4 || !clienteM6) throw new Error("Faltan clienteM3, clienteM4 y/o clienteM6");
  const requeridas = ["m3EnviarOfertas", "m6ConductorAsignado", "m4ReservarConductor", "m4LiberarConductor"];
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
      await Promise.all(ofertas.map((oferta) => clienteM3.post(
        rutas.m3EnviarOfertas(),
        {
          offerId: oferta.ofertaId,
          driverId: oferta.conductorId,
          requestId: solicitudId,
          pickupAddress: `${origen.latitud}, ${origen.longitud}`,
          destinationAddress: `${destino.latitud}, ${destino.longitud}`,
          vehicleType: tipoVehiculo,
          expiresAt: new Date(venceEn).toISOString(),
        },
        { claveIdempotencia: `ofertas:${solicitudId}:${huella}:${oferta.ofertaId}` }
      )));
    },

    // M4: bloqueo temporal de UN conductor, antes de ofertarle. Devuelve true si quedó reservado y
    // false si M4 informa conflicto (409: otra solicitud lo reservó antes). Cualquier otro error se
    // lanza: quien llama decide si salta al siguiente candidato (el TTL de M4 cubre el caso dudoso).
    async reservarConductor({ solicitudId, conductorId }) {
      try {
        await clienteM4.post(
          rutas.m4ReservarConductor({ conductorId, solicitudId }),
          { estado_temporal: "RESERVADO", solicitud_id: solicitudId },
          { claveIdempotencia: `reservar:${solicitudId}:${conductorId}` }
        );
        return true;
      } catch (error) {
        if (error?.estado === 409) return false;
        throw error;
      }
    },

    async conductorAsignado({ solicitudId, conductorId, ofertaId, solicitud, vehiculoId }) {
      const datosViaje = solicitud ?? await solicitudes?.obtenerDatosViaje?.(solicitudId);
      if (!datosViaje) throw Object.assign(new Error("No se encontraron los datos de la solicitud asignada."), { estado: 503 });
      let vehiculo = vehiculoId ? { vehiculoId } : null;
      if (!vehiculo) vehiculo = await obtenerVehiculoConductor?.(conductorId);
      if (!vehiculo?.vehiculoId) throw Object.assign(new Error("M3 no informó el vehículo seleccionado del conductor."), { estado: 503 });
      if (vehiculo.tipoVehiculo && vehiculo.tipoVehiculo !== datosViaje.tipoVehiculo) {
        throw Object.assign(new Error("El tipo del vehículo seleccionado en M3 no coincide con la solicitud."), { estado: 409 });
      }
      if (typeof solicitudes?.actualizarVehiculoAsignado === "function") {
        const actualizado = await solicitudes.actualizarVehiculoAsignado({ solicitudId, conductorId, vehiculoId: vehiculo.vehiculoId });
        if (actualizado?.count === 0) {
          throw Object.assign(new Error("No se pudo guardar el vehículo del conductor asignado."), { estado: 503 });
        }
      }
      const viaje = await clienteM6.post(
        rutas.m6ConductorAsignado(),
        {
          requestId: solicitudId,
          ...(datosViaje.reservaId ? { reservationId: datosViaje.reservaId } : {}),
          clientId: datosViaje.clienteId,
          driverId: conductorId,
          vehicleId: vehiculo.vehiculoId,
          vehicleType: datosViaje.tipoVehiculo,
          originLatitude: datosViaje.origen.latitud,
          originLongitude: datosViaje.origen.longitud,
          destinationLatitude: datosViaje.destino.latitud,
          destinationLongitude: datosViaje.destino.longitud,
        },
        { claveIdempotencia: `viaje:${solicitudId}` }
      );
      const tripId = viaje?.id ?? viaje?.tripId;
      if (typeof tripId !== "string" || tripId.length === 0) {
        throw Object.assign(new Error("M6 no devolvió el identificador del viaje."), { estado: 502 });
      }
      return tripId;
    },

    // lista: [{ solicitudId, conductorId }]. Devuelve los conductores liberados; si M4 falla con
    // alguno, el error trae en `liberados` los que SÍ salieron.
    async liberarConductores(lista) {
      const resultados = await Promise.allSettled(
        lista.map(async (item) => {
          await clienteM4.post(
            rutas.m4LiberarConductor({ conductorId: item.conductorId, solicitudId: item.solicitudId }),
            { estado_temporal: "LIBERADO", solicitud_id: item.solicitudId },
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
