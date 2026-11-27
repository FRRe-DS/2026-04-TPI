const crypto = require("node:crypto");

function jsonCanonico(valor) {
  if (Array.isArray(valor)) return valor.map(jsonCanonico);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.keys(valor).sort().map((clave) => [clave, jsonCanonico(valor[clave])]));
  }
  return valor;
}

function validarEventoCancelado(evento) {
  const p = evento?.payload;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (evento?.eventType !== "TripCancelled" || typeof evento.eventId !== "string" ||
      typeof evento.correlationId !== "string" || typeof p?.requestId !== "string" ||
      typeof p?.tripId !== "string" || typeof p?.clientId !== "string" ||
      typeof p?.driverId !== "string" || typeof p?.requiresRedispatch !== "boolean" ||
      !uuid.test(evento.eventId) || !uuid.test(evento.correlationId) ||
      !uuid.test(p.requestId) || !uuid.test(p.tripId) || !uuid.test(p.clientId) ||
      !uuid.test(p.driverId) || !Number.isFinite(Date.parse(evento.occurredAt))) {
    throw Object.assign(new Error("Evento TripCancelled de M6 inválido"), { noReintentar: true });
  }
  return p;
}

async function procesarCancelacionM6(evento, { prisma, alRedespachar, logger }) {
  if (!prisma?.$transaction || typeof alRedespachar !== "function") {
    throw new Error("Faltan dependencias para procesar cancelaciones de M6");
  }
  const payload = validarEventoCancelado(evento);
  const payloadHash = crypto.createHash("sha256")
    .update(JSON.stringify(jsonCanonico(evento)))
    .digest("hex");

  let resultado;
  try {
    resultado = await prisma.$transaction(async (tx) => {
      await tx.eventoM6Procesado.create({
        data: {
          eventoId: evento.eventId,
          requestId: payload.requestId,
          payloadHash,
        },
      });

      let solicitud = await tx.solicitud.findUnique({
        where: { requestIdM6: payload.requestId },
      });
      if (!solicitud) {
        solicitud = await tx.solicitud.findUnique({ where: { idSolicitud: payload.requestId } });
      }
      if (!solicitud ||
          solicitud.estado.toLowerCase() !== "asignada" ||
          solicitud.idCliente !== payload.clientId ||
          solicitud.conductorId !== payload.driverId ||
          (solicitud.viajeId && solicitud.viajeId !== payload.tripId)) {
        return { resultado: "evento_obsoleto" };
      }

      const requestIdM6 = payload.requiresRedispatch ? crypto.randomUUID() : payload.requestId;
      const estado = payload.requiresRedispatch ? "buscando" : "cancelada";
      const cambio = await tx.solicitud.updateMany({
        where: {
          idSolicitud: solicitud.idSolicitud,
          estado: "asignada",
          requestIdM6: solicitud.requestIdM6,
        },
        data: {
          estado,
          conductorId: null,
          vehiculo_id: null,
          viajeId: payload.requiresRedispatch ? null : payload.tripId,
          ...(payload.requiresRedispatch
            ? { requestIdM6, intentoDespacho: { increment: 1 } }
            : {}),
        },
      });
      if (cambio.count !== 1) return { resultado: "evento_obsoleto" };

      await tx.evento.create({
        data: {
          solicitudId: solicitud.idSolicitud,
          tipo: "CANCELACION",
          conductorId: payload.driverId,
          ocurridoEn: evento.occurredAt ? new Date(evento.occurredAt) : new Date(),
          detalle: `Viaje M6 cancelado (${payload.reason || "sin motivo"}); redespacho=${payload.requiresRedispatch}`,
        },
      });

      return {
        resultado: payload.requiresRedispatch ? "redespacho" : "cancelada",
        ...(payload.requiresRedispatch ? {
          solicitud: {
            solicitudId: solicitud.idSolicitud,
            origen: { latitud: solicitud.origenLat, longitud: solicitud.origenLng },
            destino: { latitud: solicitud.destinoLat, longitud: solicitud.destinoLng },
            tipoVehiculo: solicitud.tipoVehiculo,
            ronda: solicitud.intentoDespacho + 1,
          },
        } : {}),
      };
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const existente = await prisma.eventoM6Procesado.findUnique({
      where: { eventoId: evento.eventId },
      select: { payloadHash: true },
    });
    if (!existente) throw error;
    if (existente.payloadHash !== payloadHash) {
      throw Object.assign(new Error(`M6 reutilizó eventId ${evento.eventId} con otro contenido`), { noReintentar: true });
    }
    return { resultado: "duplicado" };
  }

  if (resultado.resultado === "redespacho") {
    try {
      await alRedespachar(resultado.solicitud);
    } catch (error) {
      logger?.error({ err: error, solicitudId: resultado.solicitud.solicitudId }, "no se pudo iniciar el redespacho; se recuperará desde la base");
    }
  }
  return resultado;
}

module.exports = { procesarCancelacionM6, validarEventoCancelado };
