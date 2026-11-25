const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearRepositorioCandidatos } = require("../../src/busqueda/repositorioCandidatos");
const { crearPrismaFalso } = require("../soporte/prismaFalso");

const AHORA = new Date("2026-10-20T12:00:00Z");
const lista = [
  { conductorId: "c1", distanciaKm: 0.1, tipoVehiculo: "AUTO" },
  { conductorId: "c2", distanciaKm: 0.2505, tipoVehiculo: "AUTO" },
  { conductorId: "c3", distanciaKm: 0.9, tipoVehiculo: "AUTO" },
];
const reservar = (repo, solicitudId, ids, ronda = 1) =>
  Promise.all(ids.map((conductorId) => repo.marcarReservado({ solicitudId, ronda, conductorId })));
const nuevo = () => {
  const prisma = crearPrismaFalso();
  return { prisma, repo: crearRepositorioCandidatos(prisma, { reloj: () => AHORA }) };
};

describe("repositorio de candidatos (lista devuelta por M4)", () => {
  test("guarda la lista con su posición y es idempotente", async () => {
    const { prisma, repo } = nuevo();
    assert.deepEqual(await repo.guardar({ solicitudId: "s1", lista }), { guardados: 3 });
    assert.deepEqual(await repo.guardar({ solicitudId: "s1", lista }), { guardados: 0 });
    assert.equal(prisma.filasCandidatos.length, 3);
    assert.deepEqual(prisma.filasCandidatos.map((f) => [f.conductorId, f.posicion, f.ronda, f.reservadoEn, f.liberadoEn]), [
      ["c1", 0, 1, null, null], ["c2", 1, 1, null, null], ["c3", 2, 1, null, null],
    ]);
  });

  test("marcarReservado es condicional: marca una sola vez y solo la fila de esa ronda", async () => {
    const { prisma, repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    assert.deepEqual(await repo.marcarReservado({ solicitudId: "s1", conductorId: "c1" }), { marcados: 1 });
    assert.deepEqual(await repo.marcarReservado({ solicitudId: "s1", conductorId: "c1" }), { marcados: 0 });
    assert.deepEqual(await repo.marcarReservado({ solicitudId: "s1", ronda: 2, conductorId: "c1" }), { marcados: 0 });
    assert.equal(prisma.filasCandidatos.find((f) => f.conductorId === "c1").reservadoEn.getTime(), AHORA.getTime());
    assert.equal(prisma.filasCandidatos.find((f) => f.conductorId === "c2").reservadoEn, null);
  });

  test("pendientes: solo los que M5 reservó y siguen reservados, en orden, sin el ganador", async () => {
    const { repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    await repo.guardar({ solicitudId: "otra", lista });
    await reservar(repo, "s1", ["c1", "c2", "c3"]);
    await reservar(repo, "otra", ["c1", "c2", "c3"]);
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "s1" }), ["c1", "c2", "c3"]);
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "s1", exceptoConductorId: "c2" }), ["c1", "c3"]);
  });

  test("un candidato que M5 no reservó (conflicto en M4) nunca figura como pendiente de liberar", async () => {
    const { repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    await reservar(repo, "s1", ["c1", "c3"]);
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "s1" }), ["c1", "c3"]);
  });

  test("marcarLiberados es condicional: no vuelve a marcar y no toca otras solicitudes", async () => {
    const { prisma, repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    await repo.guardar({ solicitudId: "otra", lista });
    await reservar(repo, "s1", ["c1", "c2", "c3"]);
    await reservar(repo, "otra", ["c1", "c2", "c3"]);
    assert.deepEqual(await repo.marcarLiberados({ solicitudId: "s1", conductorIds: ["c1", "c2"] }), { marcados: 2 });
    assert.deepEqual(await repo.marcarLiberados({ solicitudId: "s1", conductorIds: ["c1", "c3"] }), { marcados: 1 });
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "s1" }), []);
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "otra" }), ["c1", "c2", "c3"]);
    assert.equal(prisma.filasCandidatos.find((f) => f.solicitudId === "s1" && f.conductorId === "c1").liberadoEn.getTime(), AHORA.getTime());
    assert.deepEqual(await repo.marcarLiberados({ solicitudId: "s1", conductorIds: [] }), { marcados: 0 });
  });

  test("una segunda ronda (p. ej. si el conductor cancela) no pisa la primera", async () => {
    const { prisma, repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", ronda: 1, lista });
    await reservar(repo, "s1", ["c1", "c2", "c3"]);
    await repo.marcarLiberados({ solicitudId: "s1", conductorIds: ["c1", "c2", "c3"] });
    await repo.guardar({ solicitudId: "s1", ronda: 2, lista: [lista[0], { conductorId: "c9", distanciaKm: 0.05, tipoVehiculo: "AUTO" }] });
    await reservar(repo, "s1", ["c1", "c9"], 2);
    assert.equal(prisma.filasCandidatos.length, 5);
    assert.deepEqual(await repo.pendientesDeLiberar({ solicitudId: "s1" }), ["c1", "c9"], "c1 vuelve a estar reservado en la ronda 2");
  });

  test("pendientesDeOfertar: en orden de cercanía, sin los reservados, omitidos ni liberados", async () => {
    const { repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    await repo.guardar({ solicitudId: "otra", lista });
    assert.deepEqual((await repo.pendientesDeOfertar({ solicitudId: "s1" })).map((c) => c.conductorId), ["c1", "c2", "c3"]);
    await reservar(repo, "s1", ["c1"]);
    assert.deepEqual(await repo.marcarOmitidos({ solicitudId: "s1", conductorIds: ["c2"] }), { marcados: 1 });
    assert.deepEqual(await repo.pendientesDeOfertar({ solicitudId: "s1" }), [{ conductorId: "c3", distanciaKm: 0.9, tipoVehiculo: "AUTO" }]);
    assert.equal((await repo.pendientesDeOfertar({ solicitudId: "otra" })).length, 3, "no toca otras solicitudes");
  });

  test("marcarOmitidos es condicional: no marca a un reservado ni repite", async () => {
    const { repo } = nuevo();
    await repo.guardar({ solicitudId: "s1", lista });
    await reservar(repo, "s1", ["c1"]);
    assert.deepEqual(await repo.marcarOmitidos({ solicitudId: "s1", conductorIds: ["c1", "c2"] }), { marcados: 1 });
    assert.deepEqual(await repo.marcarOmitidos({ solicitudId: "s1", conductorIds: ["c2"] }), { marcados: 0 });
    assert.deepEqual(await repo.marcarOmitidos({ solicitudId: "s1", conductorIds: [] }), { marcados: 0 });
  });

  test("una lista vacía no escribe nada", async () => {
    const { prisma, repo } = nuevo();
    assert.deepEqual(await repo.guardar({ solicitudId: "s1", lista: [] }), { guardados: 0 });
    assert.equal(prisma.filasCandidatos.length, 0);
  });
});
