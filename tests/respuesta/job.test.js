const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { escenarioConOfertas } = require("../soporte/fakes");
const { iniciarJobVencimientos, procesarRechazo } = require("../../src/respuesta");
const { procesarAceptacion } = require("../../src/asignacion");

const logger = { error() {}, warn() {}, info() {} };
const VENCIDA = new Date("2026-10-20T11:00:00Z"); // anterior al reloj fijo del mundo (12:00)

function conJob(m) {
  const job = iniciarJobVencimientos({ deps: m.deps, intervaloMs: 1e9, logger });
  return job;
}

describe("job de vencimientos (RF-5.4, RNF-11)", () => {
  test("vence las ofertas, libera a los conductores y declara agotada UNA sola vez", async () => {
    const m = escenarioConOfertas(3, { venceEn: VENCIDA, candidatosRestantes: 0 });
    const job = conJob(m);
    const resumen = await job.ciclo();
    job.detener();
    assert.deepEqual(resumen, { vencidas: 3, errores: 0, solicitudesEvaluadas: 1 });
    assert.deepEqual([...m.estado.ofertas.values()].map((o) => o.estado), ["vencida", "vencida", "vencida"]);
    assert.equal(m.espias.liberados.length, 3);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "sin_disponibilidad");
    assert.equal(m.estado.eventos.filter((e) => e.tipo === "VENCIMIENTO").length, 3);
    assert.equal(m.estado.eventos.filter((e) => e.tipo === "BUSQUEDA").length, 1, "la señal sale una sola vez");
  });

  test("no toca ofertas vigentes ni ya resueltas", async () => {
    const m = escenarioConOfertas(3, { venceEn: VENCIDA });
    m.estado.ofertas.get("of-1").estado = "aceptada";
    m.estado.ofertas.get("of-2").estado = "rechazada";
    m.estado.ofertas.get("of-3").venceEn = new Date("2026-10-20T12:05:00Z"); // vigente
    const job = conJob(m);
    assert.deepEqual(await job.ciclo(), { vencidas: 0, errores: 0, solicitudesEvaluadas: 0 });
    job.detener();
    assert.deepEqual([...m.estado.ofertas.values()].map((o) => o.estado), ["aceptada", "rechazada", "pendiente"]);
  });

  test("con candidatos restantes la búsqueda NO se declara agotada", async () => {
    const m = escenarioConOfertas(2, { venceEn: VENCIDA, candidatosRestantes: 2 });
    const job = conJob(m);
    await job.ciclo();
    job.detener();
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "buscando");
  });

  test("una oferta que falla no frena a las demás y se cuenta como error", async () => {
    const m = escenarioConOfertas(3, { venceEn: VENCIDA });
    const original = m.deps.ofertas.vencer;
    m.deps.ofertas.vencer = async (datos, tx) => {
      if (datos.ofertaId === "of-2") throw new Error("falla de base");
      return original(datos, tx);
    };
    const job = conJob(m);
    const resumen = await job.ciclo();
    job.detener();
    assert.equal(resumen.vencidas, 2);
    assert.equal(resumen.errores, 1);
    assert.deepEqual([...m.estado.ofertas.values()].map((o) => o.estado), ["vencida", "pendiente", "vencida"]);
    assert.equal(m.estado.eventos.filter((e) => e.ofertaId === "of-2").length, 0, "su evento se deshizo");
  });

  test("si un aviso falla, la oferta igual queda vencida", async () => {
    const m = escenarioConOfertas(1, { venceEn: VENCIDA });
    m.espias.fallar.liberar = true;
    const job = conJob(m);
    const resumen = await job.ciclo();
    job.detener();
    assert.equal(resumen.vencidas, 1);
    assert.equal(m.estado.ofertas.get("of-1").estado, "vencida");
  });

  test("dos ciclos a la vez no duplican nada (el segundo se omite)", async () => {
    const m = escenarioConOfertas(2, { venceEn: VENCIDA });
    const job = conJob(m);
    const [a, b] = await Promise.all([job.ciclo(), job.ciclo()]);
    job.detener();
    assert.equal([a, b].filter((r) => r.omitido).length, 1);
    assert.equal(m.espias.liberados.length, 2);
  });

  test("el job y una aceptación sobre la misma oferta: gana una sola y el estado queda coherente", async () => {
    // La oferta vence a las 12:00:00. La aceptación mira un reloj de 11:59:59 (todavía vigente) y el job
    // uno de 12:00:01 (ya vencida): cada uno es correcto con SU reloj y solo una escritura condicional gana.
    for (let i = 0; i < 40; i++) {
      const m = escenarioConOfertas(1, { venceEn: new Date("2026-10-20T12:00:00Z") });
      const depsAceptacion = { ...m.deps, reloj: () => new Date("2026-10-20T11:59:59Z") };
      const depsJob = { ...m.deps, reloj: () => new Date("2026-10-20T12:00:01Z") };
      const job = iniciarJobVencimientos({ deps: depsJob, intervaloMs: 1e9, logger });
      const pedidos = [procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, depsAceptacion), job.ciclo()];
      if (i % 2) pedidos.reverse();
      await Promise.all(pedidos);
      job.detener();
      const o = m.estado.ofertas.get("of-1").estado;
      const s = m.estado.solicitudes.get("sol-1").estado;
      const hay = (tipo) => m.estado.eventos.filter((e) => e.tipo === tipo).length;
      assert.ok(["aceptada", "vencida"].includes(o), o);
      if (o === "aceptada") {
        assert.equal(s, "asignada");
        assert.equal(hay("VENCIMIENTO"), 0);
      } else {
        assert.notEqual(s, "asignada");
        assert.equal(hay("ACEPTACION"), 0);
        assert.equal(hay("VENCIMIENTO"), 1);
      }
    }
  });

  test("falta ofertas.vencer: el job no arranca y dice qué falta", () => {
    const m = escenarioConOfertas(1);
    delete m.deps.ofertas.vencer;
    assert.throws(() => iniciarJobVencimientos({ deps: m.deps, logger }), /ofertas\.vencer/);
  });
});
