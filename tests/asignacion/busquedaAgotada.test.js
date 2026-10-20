const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { estaAgotada, evaluarBusquedaAgotada, procesarBusquedaAgotada, procesarAceptacion } = require("../../src/asignacion");
const { EstadoSolicitud, EstadoBusqueda, EstadoOferta, TipoEvento } = require("../../src/comun/estados");
const { escenarioConOfertas } = require("../soporte/fakes");

const t = (s) => new Date(`2026-10-20T${s}Z`);

describe("Regla de búsqueda agotada (función pura)", () => {
  const base = { ofertasPendientes: 0, candidatosRestantes: 0, venceEn: t("12:10:00"), ahora: t("12:00:00") };

  test("sin ofertas pendientes y sin candidatos -> agotada", () => {
    assert.equal(estaAgotada(base), true);
  });
  test("con una oferta pendiente nunca está agotada", () => {
    assert.equal(estaAgotada({ ...base, ofertasPendientes: 1 }), false);
    assert.equal(estaAgotada({ ...base, ofertasPendientes: 1, ahora: t("13:00:00") }), false);
  });
  test("quedan candidatos y hay tiempo -> sigue activa", () => {
    assert.equal(estaAgotada({ ...base, candidatosRestantes: 2 }), false);
  });
  test("quedan candidatos pero se pasó la fecha límite (sin pendientes) -> agotada", () => {
    assert.equal(estaAgotada({ ...base, candidatosRestantes: 2, ahora: t("12:10:00") }), true);
  });
});

describe("Señal de búsqueda agotada hacia A (RF-5.8)", () => {
  test("no hay ofertas pendientes ni candidatos: marca SIN_DISPONIBILIDAD, cierra y deja evento", async () => {
    const m = escenarioConOfertas(0, { candidatosRestantes: 0 });
    const r = await evaluarBusquedaAgotada({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.agotada, true);
    assert.equal(r.senalEnviada, true);
    assert.equal(r.motivo, "SIN_CANDIDATOS");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.SIN_DISPONIBILIDAD);
    assert.equal(m.estado.busquedas.get("sol-1").estado, EstadoBusqueda.AGOTADA);
    assert.equal(m.estado.eventos.filter((e) => e.tipo === TipoEvento.BUSQUEDA).length, 1);
  });

  test("motivo PERIODO_VENCIDO cuando quedan candidatos pero terminó el tiempo", async () => {
    const m = escenarioConOfertas(0, { candidatosRestantes: 4 });
    m.fijarReloj(t("12:11:00")); // la búsqueda vencía 12:10
    const r = await evaluarBusquedaAgotada({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.motivo, "PERIODO_VENCIDO");
    assert.equal(r.senalEnviada, true);
  });

  test("si todavía hay una oferta pendiente, no se señala", async () => {
    const m = escenarioConOfertas(1, { candidatosRestantes: 0 });
    const r = await evaluarBusquedaAgotada({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.agotada, false);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO);
  });

  test("la señal sale UNA sola vez aunque se evalúe muchas veces en paralelo", async () => {
    const m = escenarioConOfertas(0, { candidatosRestantes: 0 });
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => evaluarBusquedaAgotada({ solicitudId: "sol-1" }, m.deps))
    );
    assert.equal(rs.filter((r) => r.senalEnviada).length, 1);
    assert.equal(m.estado.eventos.filter((e) => e.tipo === TipoEvento.BUSQUEDA).length, 1);
  });

  test("si un conductor ya fue asignado, la señal de agotada no pisa la asignación", async () => {
    const m = escenarioConOfertas(1, { candidatosRestantes: 0 });
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const r = await procesarBusquedaAgotada({ solicitudId: "sol-1", motivo: "SIN_CANDIDATOS" }, m.deps);
    assert.equal(r.senalEnviada, false);
    assert.equal(r.estadoSolicitud, EstadoSolicitud.ASIGNADA);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.ASIGNADA);
  });

  test("carrera: la última oferta se acepta y a la vez se evalúa 'agotada' -> nunca quedan las dos cosas", async () => {
    for (let i = 0; i < 100; i++) {
      const m = escenarioConOfertas(1, { candidatosRestantes: 0 });
      await Promise.all([
        procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps),
        procesarBusquedaAgotada({ solicitudId: "sol-1", motivo: "SIN_CANDIDATOS" }, m.deps),
      ]);
      const sol = m.estado.solicitudes.get("sol-1").estado;
      assert.ok([EstadoSolicitud.ASIGNADA, EstadoSolicitud.SIN_DISPONIBILIDAD].includes(sol));
      const of = m.estado.ofertas.get("of-1").estado;
      // Coherencia: asignada <-> oferta aceptada; sin disponibilidad <-> oferta NO aceptada.
      assert.equal(sol === EstadoSolicitud.ASIGNADA, of === EstadoOferta.ACEPTADA);
    }
  });
});
