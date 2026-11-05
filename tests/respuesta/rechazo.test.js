const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { escenarioConOfertas } = require("../soporte/fakes");
const { procesarRechazo, ResultadoRespuesta } = require("../../src/respuesta");
const { procesarAceptacion } = require("../../src/asignacion");

describe("procesarRechazo (RF-5.5)", () => {
  test("rechazo normal: cambia la oferta, registra el evento y libera al conductor", async () => {
    const m = escenarioConOfertas(2);
    const r = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, ResultadoRespuesta.RECHAZADA);
    assert.equal(r.repetida, false);
    assert.equal(r.busquedaAgotada, false, "queda otra oferta pendiente");
    assert.equal(m.estado.ofertas.get("of-1").estado, "rechazada");
    assert.equal(m.estado.ofertas.get("of-2").estado, "pendiente");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "buscando");
    assert.equal(m.estado.eventos.filter((e) => e.tipo === "RECHAZO").length, 1);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId), ["cond-1"]);
    assert.deepEqual(m.espias.cacheEliminado, ["of-1"]);
  });

  test("rechazar la última oferta sin candidatos declara la búsqueda agotada", async () => {
    const m = escenarioConOfertas(1, { candidatosRestantes: 0 });
    const r = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.busquedaAgotada, true);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "sin_disponibilidad");
  });

  test("rechazo repetido: mismo resultado con repetida:true, un solo evento y un solo aviso", async () => {
    const m = escenarioConOfertas(2);
    const a = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const b = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(a.repetida, false);
    assert.equal(b.resultado, ResultadoRespuesta.RECHAZADA);
    assert.equal(b.repetida, true);
    assert.equal(m.espias.liberados.length, 1);
    assert.equal(m.estado.eventos.filter((e) => e.tipo === "RECHAZO").length, 1);
  });

  test("respuesta tardía: oferta vencida por hora aunque siga PENDIENTE", async () => {
    const m = escenarioConOfertas(1);
    m.fijarReloj(new Date("2026-10-20T12:06:00Z"));
    const r = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, "oferta_no_vigente");
    assert.equal(m.estado.eventos.length, 0, "el evento se deshizo con la transacción");
    assert.equal(m.espias.liberados.length, 0);
  });

  test("rechazar después de aceptar: SOLICITUD_NO_DISPONIBLE / YA_ACEPTADA, sin tocar nada", async () => {
    const m = escenarioConOfertas(2);
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const r = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, "solicitud_no_disponible");
    assert.equal(r.motivo, "ya_aceptada");
    assert.equal(m.estado.ofertas.get("of-1").estado, "aceptada");
  });

  test("rechazar una oferta que otro conductor ya ganó (quedó CANCELADA): OFERTA_NO_VIGENTE", async () => {
    const m = escenarioConOfertas(2);
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const r = await procesarRechazo({ ofertaId: "of-2", conductorId: "cond-2" }, m.deps);
    assert.equal(r.resultado, "oferta_no_vigente");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, "asignada");
  });

  test("oferta de otro conductor: CONDUCTOR_NO_AUTORIZADO; inexistente: NO_ENCONTRADO", async () => {
    const m = escenarioConOfertas(2);
    assert.equal((await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-2" }, m.deps)).resultado, "conductor_no_autorizado");
    assert.equal((await procesarRechazo({ ofertaId: "no-existe", conductorId: "cond-1" }, m.deps)).resultado, "no_encontrado");
    assert.equal(m.estado.ofertas.get("of-1").estado, "pendiente");
  });

  test("si falla un aviso, el rechazo igual queda guardado y se informa en avisosFallidos", async () => {
    const m = escenarioConOfertas(2);
    m.espias.fallar.liberar = true;
    m.espias.fallar.cache = true;
    const r = await procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, ResultadoRespuesta.RECHAZADA);
    assert.deepEqual(r.avisosFallidos.sort(), ["cacheOfertas", "liberarConductores"]);
    assert.equal(m.estado.ofertas.get("of-1").estado, "rechazada");
  });

  test("rechazar y aceptar la MISMA oferta a la vez: gana exactamente una de las dos", async () => {
    for (let i = 0; i < 40; i++) {
      const m = escenarioConOfertas(1);
      const pedidos = [
        procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps),
        procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps),
      ];
      if (i % 2) pedidos.reverse();
      const [x, y] = await Promise.all(pedidos);
      const final = m.estado.ofertas.get("of-1").estado;
      assert.ok(["rechazada", "aceptada"].includes(final), final);
      // La solicitud queda coherente con la oferta.
      assert.equal(m.estado.solicitudes.get("sol-1").estado, final === "aceptada" ? "asignada" : "buscando");
      assert.ok(x && y);
    }
  });

  test("falta ofertas.rechazar: avisa claramente qué falta", async () => {
    const m = escenarioConOfertas(1);
    delete m.deps.ofertas.rechazar;
    await assert.rejects(procesarRechazo({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps), /ofertas\.rechazar/);
  });
});
