const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { crearPrismaFalso } = require("../soporte/prismaFalso");
const { crearRepositorioOfertas, crearEjecutarEnTransaccion } = require("../../src/respuesta");

const AHORA = new Date("2026-10-20T12:00:00Z");
const FUTURO = new Date("2026-10-20T12:05:00Z");
const PASADO = new Date("2026-10-20T11:59:00Z");

const oferta = (n, extra = {}) => ({
  ofertaId: `of-${n}`, solicitudId: "sol-1", conductorId: `cond-${n}`, estado: "pendiente", venceEn: FUTURO, ...extra,
});
function armar(ofertas) {
  const prisma = crearPrismaFalso(ofertas);
  return { prisma, repo: crearRepositorioOfertas(prisma, { reloj: () => AHORA }) };
}

describe("repositorioOfertas: escrituras condicionales", () => {
  test("aceptar gana una sola vez y deja respondidaEn", async () => {
    const { prisma, repo } = armar([oferta(1)]);
    assert.deepEqual(await repo.aceptar({ ofertaId: "of-1", conductorId: "cond-1", ahora: AHORA }), { aceptada: true });
    assert.deepEqual(await repo.aceptar({ ofertaId: "of-1", conductorId: "cond-1", ahora: AHORA }), { aceptada: false });
    assert.equal(prisma.filas[0].estado, "aceptada");
    assert.equal(prisma.filas[0].respondidaEn, AHORA);
  });

  test("aceptar falla si es de otro conductor", async () => {
    const { prisma, repo } = armar([oferta(1)]);
    assert.deepEqual(await repo.aceptar({ ofertaId: "of-1", conductorId: "cond-9", ahora: AHORA }), { aceptada: false });
    assert.equal(prisma.filas[0].estado, "pendiente");
  });

  test("aceptar falla si venció por hora aunque siga PENDIENTE", async () => {
    const { prisma, repo } = armar([oferta(1, { venceEn: PASADO })]);
    assert.deepEqual(await repo.aceptar({ ofertaId: "of-1", conductorId: "cond-1", ahora: AHORA }), { aceptada: false });
    assert.equal(prisma.filas[0].estado, "pendiente");
  });

  test("rechazar sigue las mismas reglas y no pisa una oferta ya aceptada", async () => {
    const { prisma, repo } = armar([oferta(1), oferta(2, { estado: "aceptada" })]);
    assert.deepEqual(await repo.rechazar({ ofertaId: "of-1", conductorId: "cond-1", ahora: AHORA }), { rechazada: true });
    assert.deepEqual(await repo.rechazar({ ofertaId: "of-1", conductorId: "cond-1", ahora: AHORA }), { rechazada: false });
    assert.deepEqual(await repo.rechazar({ ofertaId: "of-2", conductorId: "cond-2", ahora: AHORA }), { rechazada: false });
    assert.equal(prisma.filas[1].estado, "aceptada");
  });

  test("cancelarPendientesDeSolicitud: devuelve las canceladas y respeta la excepción y otras solicitudes", async () => {
    const { prisma, repo } = armar([
      oferta(1), oferta(2), oferta(3, { estado: "rechazada" }), oferta(4, { solicitudId: "sol-2" }),
    ]);
    const canceladas = await repo.cancelarPendientesDeSolicitud({ solicitudId: "sol-1", exceptoOfertaId: "of-1" });
    assert.deepEqual(canceladas, [{ ofertaId: "of-2", conductorId: "cond-2" }]);
    assert.deepEqual(prisma.filas.map((f) => f.estado), ["pendiente", "cancelada", "rechazada", "pendiente"]);
    assert.deepEqual(await repo.cancelarPendientesDeSolicitud({ solicitudId: "sol-9" }), []);
  });

  test("contarPendientes cuenta solo las vigentes por hora", async () => {
    const { repo } = armar([oferta(1), oferta(2, { venceEn: PASADO }), oferta(3, { estado: "vencida" })]);
    assert.equal(await repo.contarPendientes("sol-1"), 1);
  });

  test("obtenerPorId devuelve solo los campos del contrato, o null", async () => {
    const { repo } = armar([oferta(1)]);
    assert.deepEqual(Object.keys(await repo.obtenerPorId("of-1")).sort(),
      ["conductorId", "estado", "ofertaId", "solicitudId", "venceEn"]);
    assert.equal(await repo.obtenerPorId("nada"), null);
  });
});

describe("repositorioOfertas: vencimientos", () => {
  test("listarVencidas trae solo pendientes vencidas, las más viejas primero y respeta el lote", async () => {
    const { repo } = armar([
      oferta(1, { venceEn: new Date("2026-10-20T11:58:00Z") }),
      oferta(2, { venceEn: PASADO }),
      oferta(3),
      oferta(4, { venceEn: PASADO, estado: "aceptada" }),
    ]);
    const todas = await repo.listarVencidas({ ahora: AHORA, lote: 10 });
    assert.deepEqual(todas.map((o) => o.ofertaId), ["of-1", "of-2"]);
    assert.equal((await repo.listarVencidas({ ahora: AHORA, lote: 1 })).length, 1);
  });

  test("vencer es condicional: no toca una oferta aceptada ni una todavía vigente", async () => {
    const { prisma, repo } = armar([
      oferta(1, { venceEn: PASADO }), oferta(2, { venceEn: PASADO, estado: "aceptada" }), oferta(3),
    ]);
    assert.deepEqual(await repo.vencer({ ofertaId: "of-1", ahora: AHORA }), { vencida: true });
    assert.deepEqual(await repo.vencer({ ofertaId: "of-1", ahora: AHORA }), { vencida: false });
    assert.deepEqual(await repo.vencer({ ofertaId: "of-2", ahora: AHORA }), { vencida: false });
    assert.deepEqual(await repo.vencer({ ofertaId: "of-3", ahora: AHORA }), { vencida: false });
    assert.deepEqual(prisma.filas.map((f) => f.estado), ["vencida", "aceptada", "pendiente"]);
  });
});

describe("crearEjecutarEnTransaccion", () => {
  test("pasa el tx a la función y configura espera y tiempo máximo", async () => {
    const prisma = crearPrismaFalso();
    const ejecutar = crearEjecutarEnTransaccion(prisma, { maxWaitMs: 1000, timeoutMs: 3000 });
    const r = await ejecutar(async (tx) => (tx === prisma ? "tx recibido" : "otro"));
    assert.equal(r, "tx recibido");
    assert.deepEqual(prisma.llamadas.transaccion, [{ maxWait: 1000, timeout: 3000 }]);
  });
});
