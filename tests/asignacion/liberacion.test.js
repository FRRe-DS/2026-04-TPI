const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { procesarAceptacion, procesarCancelacionSolicitud, procesarBusquedaAgotada } = require("../../src/asignacion");
const { procesarRechazo, iniciarJobVencimientos } = require("../../src/respuesta");
const { escenarioConOfertas } = require("../soporte/fakes");

const logger = { error() {}, warn() {}, info() {} };
const porConductor = (m) => Object.fromEntries(m.espias.liberados.map((l) => [l.conductorId, l]));
const reservados = (m) => [...m.estado.candidatos.values()].filter((c) => !c.liberadoEn).map((c) => c.conductorId).sort();

describe("M4 reserva a toda la lista: se libera a todos los que sigan reservados", () => {
  test("al asignar: se libera a los perdedores CON oferta y a los que nunca la recibieron, menos al ganador", async () => {
    const m = escenarioConOfertas(2, { sinOferta: 2 });
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.deepEqual(r.avisosFallidos, []);

    const libres = porConductor(m);
    assert.deepEqual(Object.keys(libres).sort(), ["cond-2", "cond-extra-1", "cond-extra-2"]);
    assert.deepEqual(reservados(m), ["cond-1"], "solo el ganador sigue sin liberar");
  });

  test("el que ya salió por oferta_rechazada NO se libera otra vez al cerrar", async () => {
    const m = escenarioConOfertas(3, { sinOferta: 1 });
    await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId), ["cond-1"]);

    await procesarAceptacion({ ofertaId: "of-2", conductorId: "cond-2" }, m.deps);
    const veces = m.espias.liberados.filter((l) => l.conductorId === "cond-1").length;
    assert.equal(veces, 1, "cond-1 se liberó una sola vez");
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId).sort(), ["cond-1", "cond-3", "cond-extra-1"]);
  });

  test("el que ya salió por oferta_vencida tampoco se libera otra vez", async () => {
    const m = escenarioConOfertas(3);
    m.estado.ofertas.get("of-1").venceEn = new Date("2026-10-20T11:00:00Z"); // venció (el reloj del mundo marca 12:00)
    const job = iniciarJobVencimientos({ deps: m.deps, intervaloMs: 1e9, logger });
    await job.ciclo();
    job.detener();
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId), ["cond-1"]);

    await procesarAceptacion({ ofertaId: "of-2", conductorId: "cond-2" }, m.deps);
    assert.equal(m.espias.liberados.filter((l) => l.conductorId === "cond-1").length, 1);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId).sort(), ["cond-1", "cond-3"]);
  });

  test("al cancelar el cliente: se libera a todos, haya o no ofertas pendientes", async () => {
    const m = escenarioConOfertas(2, { sinOferta: 2 });
    await m.cancelarSolicitud("sol-1");
    const r = await procesarCancelacionSolicitud({ solicitudId: "sol-1" }, m.deps);
    assert.deepEqual(r.avisosFallidos, []);
    assert.equal(m.espias.liberados.length, 4);
    assert.deepEqual(reservados(m), []);

    const sinOfertas = escenarioConOfertas(0, { sinOferta: 2 });
    await sinOfertas.cancelarSolicitud("sol-1");
    await procesarCancelacionSolicitud({ solicitudId: "sol-1" }, sinOfertas.deps);
    assert.deepEqual(sinOfertas.espias.liberados.map((l) => l.conductorId), ["cond-extra-1", "cond-extra-2"]);
  });

  test("al agotarse la búsqueda: se libera a los que sigan reservados", async () => {
    const m = escenarioConOfertas(1, { sinOferta: 2, candidatosRestantes: 0 });
    await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps); // dispara la evaluación
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "sin_disponibilidad");
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId), ["cond-1", "cond-extra-1", "cond-extra-2"]);
    assert.deepEqual(reservados(m), []);
  });

  test("agotada por sí sola informa si falló la liberación y no cambia la señal", async () => {
    const m = escenarioConOfertas(0, { sinOferta: 1, candidatosRestantes: 0 });
    m.espias.fallar.liberar = true;
    const r = await procesarBusquedaAgotada({ solicitudId: "sol-1", motivo: "SIN_CANDIDATOS" }, m.deps);
    assert.equal(r.senalEnviada, true);
    assert.deepEqual(r.avisosFallidos, ["liberarConductores"]);
    assert.deepEqual(reservados(m), ["cond-extra-1"], "sigue pendiente para reintentarlo");
  });

  test("si M4 falla con alguno, solo se marcan los que salieron; el otro queda pendiente", async () => {
    const m = escenarioConOfertas(1, { sinOferta: 2 });
    m.espias.fallar.liberarIds = ["cond-extra-2"];
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, "asignada");
    assert.deepEqual(r.avisosFallidos, ["liberarConductores"]);
    assert.deepEqual(reservados(m), ["cond-1", "cond-extra-2"]);
  });

  test("si M4 está caído no se marca a nadie como liberado", async () => {
    const m = escenarioConOfertas(1, { sinOferta: 2 });
    m.espias.fallar.liberar = true;
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.deepEqual(reservados(m), ["cond-1", "cond-extra-1", "cond-extra-2"]);
  });

  test("repetir la aceptación no vuelve a liberar a nadie", async () => {
    const m = escenarioConOfertas(1, { sinOferta: 2 });
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const antes = m.espias.liberados.length;
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(m.espias.liberados.length, antes);
  });
});
