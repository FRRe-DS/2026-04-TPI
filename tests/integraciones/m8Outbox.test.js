const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { crearOutboxM8 } = require("../../src/integraciones/m8Outbox");

function crearPrismaFalso() {
  const filas = new Map();
  return {
    filas,
    notificacionM8: {
      upsert: async ({ where, create }) => {
        const key = `${where.solicitudId_requestIdM6_tipo.solicitudId}:${where.solicitudId_requestIdM6_tipo.requestIdM6}:${where.solicitudId_requestIdM6_tipo.tipo}`;
        if (!filas.has(key)) filas.set(key, { ...create, estado: "PENDIENTE", intentos: 0, proximoIntento: new Date(0), creadoEn: new Date(0) });
      },
      findMany: async ({ where }) => [...filas.values()]
        .filter((f) => f.estado === where.estado && f.proximoIntento <= where.proximoIntento.lte)
        .sort((a, b) => a.creadoEn - b.creadoEn)
        .slice(0, 25),
      findFirst: async ({ where }) => [...filas.values()].find((f) =>
        f.solicitudId === where.solicitudId &&
        f.requestIdM6 === where.requestIdM6 &&
        f.tipo === where.tipo &&
        f.estado !== where.estado.not
      ) || null,
      updateMany: async ({ where, data }) => {
        const fila = [...filas.values()].find((f) => f.eventoId === where.eventoId && f.estado === where.estado);
        if (!fila) return { count: 0 };
        Object.assign(fila, data);
        return { count: 1 };
      },
    },
  };
}

const datos = {
  solicitudId: "s1",
  requestIdM6: "r1",
  viajeId: "v1",
  conductorId: "c1",
  datosViaje: {
    clienteId: "client-1",
    clienteEmail: "cliente@example.test",
    reservaId: null,
    tipoVehiculo: "AUTO",
    costo: 1200,
    moneda: "ARS",
    creadaEn: new Date("2026-11-26T10:00:00.000Z"),
  },
};

describe("outbox de eventos de viaje a M8", () => {
  test("encola los tipos que M8 acepta con ids y referencias válidas", async () => {
    const prisma = crearPrismaFalso();
    const outbox = crearOutboxM8({
      prisma,
      clienteM8: { post: async () => {} },
      obtenerToken: async () => "token",
      reloj: () => new Date("2026-11-26T12:00:00.000Z"),
    });

    await outbox.encolarEventosViaje(datos);
    const filas = [...prisma.filas.values()];

    assert.deepEqual(filas.map((f) => f.tipo), ["VIAJE_SOLICITADO", "VIAJE_ASIGNADO"]);
    assert.ok(filas.every((f) => f.cuerpo.viajeId === "v1" && f.cuerpo.origen === "M5"));
    assert.equal(filas[0].cuerpo.ocurridoEn, "2026-11-26T10:00:00.000Z");
    // El contrato oficial de M8 (DetalleEvento) no admite campos extra: el conductor no viaja en el
    // detalle (se sacó en el commit 2d4634d).
    assert.equal(filas[1].cuerpo.detalle.conductorId, undefined);
    assert.equal(filas[1].cuerpo.detalle.tipoVehiculo, datos.datosViaje.tipoVehiculo);
    assert.equal(filas[1].cuerpo.destinatarios[0].email, "cliente@example.test");
  });

  test("respeta el orden VIAJE_SOLICITADO antes de VIAJE_ASIGNADO", async () => {
    const prisma = crearPrismaFalso();
    const llamadas = [];
    const outbox = crearOutboxM8({
      prisma,
      clienteM8: { post: async (_ruta, cuerpo) => { llamadas.push(cuerpo.tipo); } },
      obtenerToken: async () => "token",
      reloj: () => new Date("2026-11-26T12:00:00.000Z"),
    });
    await outbox.encolarEventosViaje(datos);

    assert.deepEqual(await outbox.ciclo(), { enviadas: 2, reintentadas: 0, fallidas: 0 });
    assert.deepEqual(llamadas, ["VIAJE_SOLICITADO", "VIAJE_ASIGNADO"]);
  });

  test("un error reintentable conserva el evento y vuelve a enviarlo con el mismo eventoId", async () => {
    const prisma = crearPrismaFalso();
    const ids = [];
    let falla = true;
    let ahora = new Date("2026-11-26T12:00:00.000Z");
    const outbox = crearOutboxM8({
      prisma,
      clienteM8: {
        post: async (_ruta, cuerpo) => {
          ids.push(cuerpo.eventoId);
          if (falla) {
            falla = false;
            throw Object.assign(new Error("M8 no disponible"), { estado: 503 });
          }
        },
      },
      obtenerToken: async () => "token",
      logger: { error() {} },
      reloj: () => ahora,
    });
    await outbox.encolarEventosViaje(datos);

    assert.equal((await outbox.ciclo()).reintentadas, 1);
    ahora = new Date(ahora.getTime() + 2000);
    assert.equal((await outbox.ciclo()).enviadas, 2);
    assert.equal(ids[0], ids[1]);
  });
});
