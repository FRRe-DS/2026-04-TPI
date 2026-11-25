const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { iniciarDespacho, enviarTanda, iniciarJobTandas } = require("../../src/ofertas");
const { procesarRechazo } = require("../../src/respuesta");
const { crearMundo } = require("../soporte/fakes");
const { EstadoSolicitud, EstadoBusqueda, EstadoOferta } = require("../../src/comun/estados");

const AHORA = new Date("2026-10-20T12:00:00Z");
const en = (segundos) => new Date(AHORA.getTime() + segundos * 1000);
const logger = { error() {}, warn() {}, info() {} };

const solicitud = {
  solicitudId: "sol-1",
  origen: { latitud: -27.45, longitud: -58.98 },
  destino: { latitud: -27.47, longitud: -58.83 },
  tipoVehiculo: "AUTO",
};

// Una solicitud buscando y `n` candidatos que devolverá M4, del más cercano (c1) al más lejano.
function mundo(n, { conflictos = [], despacho } = {}) {
  const lista = Array.from({ length: n }, (_, i) => ({ conductorId: `c${i + 1}`, distanciaKm: 0.1 * (i + 1), tipoVehiculo: "AUTO" }));
  const m = crearMundo({
    solicitudes: [{ ...solicitud, estado: EstadoSolicitud.BUSCANDO, conductorAsignadoId: null }],
    ahora: AHORA,
  });
  m.espias.conflictos.push(...conflictos);
  m.deps.logger = logger;
  if (despacho) m.deps.despacho = despacho;
  m.deps.buscador = {
    async buscar(sol) {
      await m.deps.candidatos.guardar({ solicitudId: sol.solicitudId, lista });
      return lista;
    },
  };
  return { m, lista };
}
const lotes = (m) => m.espias.ofertasEnviadas.map((e) => e.ofertas.map((o) => o.conductorId));
const busqueda = (m) => m.estado.busquedas.get("sol-1");
const ofertaDe = (m, conductorId) => [...m.estado.ofertas.values()].find((o) => o.conductorId === conductorId);

describe("despacho por tandas", () => {
  test("la primera tanda son los 3 más cercanos, reservados en orden, con un solo envío a M3 que vence a los 30 s", async () => {
    const { m } = mundo(7);
    const r = await iniciarDespacho({ solicitud }, m.deps);

    assert.equal(r.resultado, "iniciado");
    assert.equal(r.tanda.resultado, "enviada");
    assert.deepEqual(m.espias.reservados.map((x) => x.conductorId), ["c1", "c2", "c3"]);
    assert.deepEqual(lotes(m), [["c1", "c2", "c3"]]);

    const envio = m.espias.ofertasEnviadas[0];
    assert.equal(envio.solicitudId, "sol-1");
    assert.equal(new Date(envio.venceEn).toISOString(), "2026-10-20T12:00:30.000Z");
    assert.deepEqual(envio.origen, solicitud.origen);
    assert.deepEqual(envio.destino, solicitud.destino);
    assert.equal(envio.tipoVehiculo, "AUTO");

    const ofertas = [...m.estado.ofertas.values()];
    assert.equal(ofertas.length, 3);
    assert.ok(ofertas.every((o) => o.estado === EstadoOferta.PENDIENTE && o.solicitudId === "sol-1"));
    assert.deepEqual(envio.ofertas.map((o) => o.ofertaId).sort(), ofertas.map((o) => o.ofertaId).sort());
    assert.equal(busqueda(m).candidatosRestantes, 4);
    assert.equal(busqueda(m).proximaTandaEn.toISOString(), "2026-10-20T12:00:20.000Z");
  });

  test("a los 20 s sale la siguiente tanda con los que siguen en la lista; antes de eso no sale nada", async () => {
    const { m } = mundo(7);
    await iniciarDespacho({ solicitud }, m.deps);
    const job = iniciarJobTandas({ deps: m.deps, intervaloMs: 1e9 });

    m.fijarReloj(en(19));
    assert.equal((await job.ciclo()).enviadas, 0);
    assert.equal(lotes(m).length, 1);

    m.fijarReloj(en(20));
    assert.equal((await job.ciclo()).enviadas, 1);
    m.fijarReloj(en(40));
    assert.equal((await job.ciclo()).enviadas, 1);
    job.detener();

    assert.deepEqual(lotes(m), [["c1", "c2", "c3"], ["c4", "c5", "c6"], ["c7"]]);
    assert.equal(busqueda(m).candidatosRestantes, 0);
  });

  test("un conductor que M4 informa en conflicto se omite y se completa la tanda con el siguiente; no se reintenta", async () => {
    const { m } = mundo(7, { conflictos: ["c2"] });
    await iniciarDespacho({ solicitud }, m.deps);
    assert.deepEqual(lotes(m), [["c1", "c3", "c4"]]);
    assert.ok(m.estado.candidatos.get("sol-1:c2").omitidoEn);
    assert.equal(busqueda(m).candidatosRestantes, 3);

    const job = iniciarJobTandas({ deps: m.deps, intervaloMs: 1e9 });
    m.fijarReloj(en(20));
    await job.ciclo();
    job.detener();
    assert.deepEqual(lotes(m)[1], ["c5", "c6", "c7"]);
    assert.ok(!m.espias.reservados.slice(3).some((x) => x.conductorId === "c2"), "c2 no se vuelve a pedir");
  });

  test("si todos los candidatos están en conflicto, la solicitud queda sin disponibilidad y no sale ninguna oferta", async () => {
    const { m } = mundo(2, { conflictos: ["c1", "c2"] });
    const r = await iniciarDespacho({ solicitud }, m.deps);
    assert.equal(r.tanda.resultado, "sin_candidatos");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.SIN_DISPONIBILIDAD);
    assert.equal(busqueda(m).estado, EstadoBusqueda.AGOTADA);
    assert.equal(m.espias.ofertasEnviadas.length, 0);
    assert.equal(m.espias.liberados.length, 0, "nunca se reservó a nadie: no hay a quién liberar");
  });

  test("lista vacía de M4: sin disponibilidad, sin ofertas", async () => {
    const { m } = mundo(0);
    const r = await iniciarDespacho({ solicitud }, m.deps);
    assert.equal(r.resultado, "sin_candidatos");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.SIN_DISPONIBILIDAD);
    assert.equal(m.espias.ofertasEnviadas.length, 0);
  });

  test("si M3 no recibe el lote no se rompe nada: las ofertas quedan guardadas y se informa", async () => {
    const { m } = mundo(5);
    m.espias.fallar.enviarOfertas = true;
    const r = await iniciarDespacho({ solicitud }, m.deps);
    assert.equal(r.tanda.resultado, "enviada_con_error");
    assert.equal([...m.estado.ofertas.values()].length, 3);
    assert.ok(m.estado.eventos.some((e) => /M3/.test(e.detalle ?? "")));
  });

  test("si M4 no puede reservar a nadie no se descarta a ningún candidato y se reintenta en la próxima tanda", async () => {
    const { m } = mundo(7);
    m.espias.fallar.reservarIds.push("c1", "c2", "c3", "c4", "c5", "c6", "c7");
    const r = await iniciarDespacho({ solicitud }, m.deps);
    assert.equal(r.tanda.resultado, "m4_no_responde");
    assert.equal(m.espias.ofertasEnviadas.length, 0);
    assert.equal(busqueda(m).estado, EstadoBusqueda.ACTIVA);
    assert.equal(busqueda(m).candidatosRestantes, 7);
    assert.ok([...m.estado.candidatos.values()].every((c) => !c.omitidoEn && !c.reservadoEn));

    m.espias.fallar.reservarIds.length = 0;
    const job = iniciarJobTandas({ deps: m.deps, intervaloMs: 1e9 });
    m.fijarReloj(en(20));
    await job.ciclo();
    job.detener();
    assert.deepEqual(lotes(m), [["c1", "c2", "c3"]]);
  });

  test("dos pedidos de tanda a la vez: sale una sola (el turno se reclama con una escritura condicional)", async () => {
    const { m } = mundo(9);
    await iniciarDespacho({ solicitud }, m.deps);
    m.fijarReloj(en(20));
    const resultados = await Promise.all([1, 2, 3].map(() => enviarTanda({ solicitudId: "sol-1" }, m.deps)));
    assert.equal(resultados.filter((r) => r.resultado === "enviada").length, 1);
    assert.equal(resultados.filter((r) => r.resultado === "sin_turno").length, 2);
    assert.deepEqual(lotes(m), [["c1", "c2", "c3"], ["c4", "c5", "c6"]]);
  });

  test("con la búsqueda cerrada (asignada o cancelada) no sale ninguna tanda más", async () => {
    const { m } = mundo(7);
    await iniciarDespacho({ solicitud }, m.deps);
    await m.deps.busquedas.cerrar({ solicitudId: "sol-1", estado: EstadoBusqueda.FINALIZADA });
    m.fijarReloj(en(20));
    const r = await enviarTanda({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.resultado, "sin_busqueda_activa");
    assert.equal(lotes(m).length, 1);
  });

  test("si la búsqueda se cierra mientras se reserva, se libera a los recién reservados y no se crea ninguna oferta", async () => {
    const { m } = mundo(7);
    const original = m.deps.candidatos.pendientesDeOfertar;
    m.deps.candidatos.pendientesDeOfertar = async (...args) => {
      const r = await original(...args);
      await m.deps.busquedas.cerrar({ solicitudId: "sol-1", estado: EstadoBusqueda.FINALIZADA }); // el cliente canceló justo ahora
      return r;
    };
    // la búsqueda se abre a mano para que el cierre ocurra dentro de la primera tanda
    await m.deps.busquedas.crear({ solicitudId: "sol-1", venceEn: en(180), candidatosRestantes: 7, proximaTandaEn: AHORA });
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista: Array.from({ length: 7 }, (_, i) => ({ conductorId: `c${i + 1}`, distanciaKm: i / 10, tipoVehiculo: "AUTO" })) });
    const r = await enviarTanda({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.resultado, "busqueda_cerrada");
    assert.equal(m.estado.ofertas.size, 0);
    assert.equal(m.espias.ofertasEnviadas.length, 0);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId).sort(), ["c1", "c2", "c3"]);
  });

  test("si los 3 de la tanda rechazan antes de los 20 s, la siguiente sale enseguida", async () => {
    const { m } = mundo(7);
    await iniciarDespacho({ solicitud }, m.deps);
    const job = iniciarJobTandas({ deps: m.deps, intervaloMs: 1e9 });

    for (const c of ["c1", "c2"]) await procesarRechazo({ ofertaId: ofertaDe(m, c).ofertaId, conductorId: c }, m.deps);
    assert.equal(busqueda(m).proximaTandaEn.toISOString(), "2026-10-20T12:00:20.000Z", "queda una oferta pendiente: se espera");
    assert.equal((await job.ciclo()).enviadas, 0);

    await procesarRechazo({ ofertaId: ofertaDe(m, "c3").ofertaId, conductorId: "c3" }, m.deps);
    assert.equal(busqueda(m).proximaTandaEn.getTime(), AHORA.getTime(), "sin pendientes: la próxima tanda es ya");
    assert.equal((await job.ciclo()).enviadas, 1);
    job.detener();
    assert.deepEqual(lotes(m), [["c1", "c2", "c3"], ["c4", "c5", "c6"]]);
  });

  test("si todos rechazan y no quedan candidatos, la solicitud queda sin disponibilidad", async () => {
    const { m } = mundo(3);
    await iniciarDespacho({ solicitud }, m.deps);
    for (const c of ["c1", "c2", "c3"]) await procesarRechazo({ ofertaId: ofertaDe(m, c).ofertaId, conductorId: c }, m.deps);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.SIN_DISPONIBILIDAD);
    assert.equal(busqueda(m).estado, EstadoBusqueda.AGOTADA);
  });

  test("pasado el plazo total de la búsqueda no salen más tandas y se agota", async () => {
    const { m } = mundo(9);
    await iniciarDespacho({ solicitud }, m.deps);
    m.fijarReloj(en(200)); // plazo de 180 s; las ofertas de la tanda 1 ya vencieron por hora
    const r = await enviarTanda({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.resultado, "plazo_vencido");
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.SIN_DISPONIBILIDAD);
    assert.equal(lotes(m).length, 1);
  });

  test("iniciar dos veces el mismo despacho no repite nada", async () => {
    const { m } = mundo(7);
    await iniciarDespacho({ solicitud }, m.deps);
    const otra = await iniciarDespacho({ solicitud }, m.deps);
    assert.equal(otra.resultado, "ya_iniciado");
    assert.equal(lotes(m).length, 1);
  });

  test("el tamaño de la tanda es configurable y se valida", async () => {
    const dos = mundo(5, { despacho: { tamanoTanda: 2 } });
    await iniciarDespacho({ solicitud }, dos.m.deps);
    assert.deepEqual(lotes(dos.m), [["c1", "c2"]]);

    const mal = mundo(5, { despacho: { tamanoTanda: 0 } });
    await assert.rejects(() => iniciarDespacho({ solicitud }, mal.m.deps), /tamanoTanda/);
  });

  test("si M4 no responde la búsqueda de candidatos el error sale y no queda nada creado", async () => {
    const { m } = mundo(3);
    m.deps.buscador = { buscar: async () => { throw new Error("M4 caído"); } };
    await assert.rejects(() => iniciarDespacho({ solicitud }, m.deps), /M4 caído/);
    assert.equal(m.estado.busquedas.size, 0);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO);
  });
});
