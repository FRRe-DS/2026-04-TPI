const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearNotificaciones, MotivoLiberacion } = require("../../src/asignacion");

describe("Avisos a M4 y M6", () => {
  const rutas = {
    m6ConductorAsignado: ({ solicitudId }) => `/m6/${solicitudId}`,
    m4LiberarConductor: ({ conductorId }) => `/m4/${conductorId}`,
    m4ConductorSeleccionado: ({ solicitudId }) => `/m4/seleccion/${solicitudId}`,
  };

  test("manda claves de idempotencia estables por aviso", async () => {
    const llamadas = [];
    const falso = (nombre) => ({ post: async (ruta, cuerpo, op) => { llamadas.push({ nombre, ruta, cuerpo, clave: op.claveIdempotencia }); } });
    const n = crearNotificaciones({ clienteM4: falso("m4"), clienteM6: falso("m6"), rutas });
    await n.conductorAsignado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1" });
    await n.conductorSeleccionado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1" });
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2", ofertaId: "o2", motivo: MotivoLiberacion.SOLICITUD_CERRADA }]);
    assert.deepEqual(llamadas.map((l) => [l.nombre, l.ruta, l.clave]), [
      ["m6", "/m6/s1", "asignacion:s1:o1"],
      ["m4", "/m4/seleccion/s1", "seleccion:s1:c1"],
      ["m4", "/m4/c2", "liberar:o2"],
    ]);
  });

  test("hacia M4 el cuerpo va en snake_case, tal cual el contrato", async () => {
    const llamadas = [];
    const clienteM4 = { post: async (ruta, cuerpo) => { llamadas.push(cuerpo); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await n.conductorSeleccionado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1" });
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2", ofertaId: "o2", motivo: MotivoLiberacion.OFERTA_RECHAZADA }]);
    assert.deepEqual(llamadas, [
      { solicitud_id: "s1", conductor_id: "c1", oferta_id: "o1" },
      { conductor_id: "c2", solicitud_id: "s1", oferta_id: "o2", motivo: "oferta_rechazada" },
    ]);
  });

  test("un candidato que nunca recibió oferta se libera con oferta_id null y clave por solicitud y conductor", async () => {
    const llamadas = [];
    const clienteM4 = { post: async (ruta, cuerpo, op) => { llamadas.push({ cuerpo, clave: op.claveIdempotencia }); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    const liberados = await n.liberarConductores([
      { solicitudId: "s1", conductorId: "c5", ofertaId: null, motivo: MotivoLiberacion.SOLICITUD_CERRADA },
    ]);
    assert.deepEqual(liberados, ["c5"]);
    assert.deepEqual(llamadas, [
      { cuerpo: { conductor_id: "c5", solicitud_id: "s1", oferta_id: null, motivo: "solicitud_cerrada" }, clave: "liberar:s1:c5" },
    ]);
  });

  test("si falla con alguno, el error indica cuáles SÍ se liberaron", async () => {
    const clienteM4 = { post: async (ruta, cuerpo) => { if (cuerpo.conductor_id === "c2") throw new Error("M4 caído"); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await assert.rejects(
      () => n.liberarConductores([
        { solicitudId: "s", conductorId: "c1", ofertaId: "o1", motivo: MotivoLiberacion.OFERTA_VENCIDA },
        { solicitudId: "s", conductorId: "c2", ofertaId: "o2", motivo: MotivoLiberacion.OFERTA_VENCIDA },
      ]),
      (e) => /1 de 2/.test(e.message) && JSON.stringify(e.liberados) === JSON.stringify(["c1"])
    );
  });

  test("los motivos de liberación son los cuatro del contrato", () => {
    assert.deepEqual(Object.values(MotivoLiberacion).sort(), [
      "cancelada_por_cliente", "oferta_rechazada", "oferta_vencida", "solicitud_cerrada",
    ]);
  });

  test("un motivo que M4 no conoce no se envía y cuenta como fallo", async () => {
    let llamadas = 0;
    const clienteM4 = { post: async () => { llamadas += 1; } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await assert.rejects(
      () => n.liberarConductores([{ solicitudId: "s", conductorId: "c1", ofertaId: "o1", motivo: "OFERTA_PERDIDA" }]),
      /1 de 1/
    );
    assert.equal(llamadas, 0);
  });

  test("si falla la liberación de alguno, lo informa (para reintentarlo)", async () => {
    const clienteM4 = { post: async (ruta) => { if (ruta.endsWith("c2")) throw new Error("M4 caído"); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await assert.rejects(
      () => n.liberarConductores([
        { solicitudId: "s", conductorId: "c1", ofertaId: "o1", motivo: MotivoLiberacion.OFERTA_VENCIDA },
        { solicitudId: "s", conductorId: "c2", ofertaId: "o2", motivo: MotivoLiberacion.OFERTA_VENCIDA },
      ]),
      /1 de 2/
    );
  });

  test("no se puede crear sin las rutas acordadas (no hay rutas inventadas)", () => {
    assert.throws(() => crearNotificaciones({ clienteM4: {}, clienteM6: {}, rutas: {} }), /rutas acordadas/);
  });
});
