const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { procesarCancelacionM6, validarEventoCancelado } = require("../../src/integraciones/m6Cancelaciones");

const solicitudId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const tripId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const driverId = "55555555-5555-4555-8555-555555555555";

function eventoM6(requiresRedispatch = true) {
  return {
    eventId: "66666666-6666-4666-8666-666666666666",
    eventType: "TripCancelled",
    eventVersion: 1,
    occurredAt: "2026-11-26T12:00:00.000Z",
    producer: "m6-viajes",
    correlationId: requestId,
    payload: {
      tripId, requestId, clientId, driverId, requiresRedispatch,
      reason: "VEHICLE_PROBLEM",
    },
  };
}

function crearPrismaFalso() {
  const solicitud = {
    idSolicitud: solicitudId,
    idCliente: clientId,
    estado: "asignada",
    conductorId: driverId,
    requestIdM6: requestId,
    intentoDespacho: 1,
    viajeId: tripId,
    origenLat: -27,
    origenLng: -58,
    destinoLat: -28,
    destinoLng: -59,
    tipoVehiculo: "AUTO",
  };
  const procesados = new Map();
  const eventos = [];
  const tx = {
    eventoM6Procesado: {
      create: async ({ data }) => {
        if (procesados.has(data.eventoId)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        procesados.set(data.eventoId, data);
        return data;
      },
    },
    solicitud: {
      findUnique: async ({ where }) => where.requestIdM6
        ? (solicitud.requestIdM6 === where.requestIdM6 ? { ...solicitud } : null)
        : (where.idSolicitud === solicitud.idSolicitud ? { ...solicitud } : null),
      updateMany: async ({ where, data }) => {
        if (where.idSolicitud !== solicitud.idSolicitud || solicitud.estado !== where.estado ||
            solicitud.requestIdM6 !== where.requestIdM6) return { count: 0 };
        const { intentoDespacho, ...resto } = data;
        Object.assign(solicitud, resto);
        if (intentoDespacho?.increment) solicitud.intentoDespacho += intentoDespacho.increment;
        return { count: 1 };
      },
    },
    evento: { create: async ({ data }) => { eventos.push(data); return data; } },
  };
  return {
    solicitud,
    eventos,
    eventoM6Procesado: { findUnique: async ({ where }) => procesados.get(where.eventoId) || null },
    $transaction: async (fn) => fn(tx),
  };
}

describe("consumo de cancelaciones de M6", () => {
  test("un evento requiresRedispatch reabre la solicitud con nuevo requestId y ronda", async () => {
    const prisma = crearPrismaFalso();
    const redespachos = [];

    const resultado = await procesarCancelacionM6(eventoM6(), {
      prisma,
      alRedespachar: async (solicitud) => redespachos.push(solicitud),
    });

    assert.equal(resultado.resultado, "redespacho");
    assert.equal(prisma.solicitud.estado, "buscando");
    assert.equal(prisma.solicitud.intentoDespacho, 2);
    assert.notEqual(prisma.solicitud.requestIdM6, requestId);
    assert.equal(prisma.solicitud.viajeId, null);
    assert.equal(redespachos.length, 1);
    assert.equal(redespachos[0].ronda, 2);
  });

  test("un evento sin redespacho cierra la solicitud y no inicia otra búsqueda", async () => {
    const prisma = crearPrismaFalso();
    let redespachos = 0;

    const resultado = await procesarCancelacionM6(eventoM6(false), {
      prisma,
      alRedespachar: async () => { redespachos += 1; },
    });

    assert.equal(resultado.resultado, "cancelada");
    assert.equal(prisma.solicitud.estado, "cancelada");
    assert.equal(prisma.solicitud.viajeId, tripId);
    assert.equal(redespachos, 0);
  });

  test("un evento repetido no vuelve a redespachar y un cuerpo inválido se rechaza", async () => {
    const prisma = crearPrismaFalso();
    let redespachos = 0;
    const options = { prisma, alRedespachar: async () => { redespachos += 1; } };
    const evento = eventoM6();

    await procesarCancelacionM6(evento, options);
    assert.equal((await procesarCancelacionM6(evento, options)).resultado, "duplicado");
    assert.equal(redespachos, 1);
    assert.throws(() => validarEventoCancelado({ ...evento, payload: {} }), { noReintentar: true });
  });
});
