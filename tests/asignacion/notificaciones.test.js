const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearNotificaciones } = require("../../src/asignacion");

describe("Avisos a M4 y M6", () => {
  const rutas = {
    m6ConductorAsignado: ({ solicitudId }) => `/m6/${solicitudId}`,
    m4LiberarConductor: ({ conductorId }) => `/m4/${conductorId}`,
  };

  test("manda claves de idempotencia estables por aviso", async () => {
    const llamadas = [];
    const falso = (nombre) => ({ post: async (ruta, cuerpo, op) => { llamadas.push({ nombre, ruta, cuerpo, clave: op.claveIdempotencia }); } });
    const n = crearNotificaciones({ clienteM4: falso("m4"), clienteM6: falso("m6"), rutas });
    await n.conductorAsignado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1" });
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2" }]);
    assert.deepEqual(llamadas.map((l) => [l.nombre, l.ruta, l.clave]), [
      ["m6", "/m6/s1", "asignacion:s1:o1"],
      ["m4", "/m4/c2", "liberar:s1:c2"],
    ]);
  });

  test("hacia M4 solo viaja el conductor y la solicitud: el mismo aviso para todos, sin motivo", async () => {
    const llamadas = [];
    const clienteM4 = { post: async (ruta, cuerpo) => { llamadas.push(cuerpo); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    const liberados = await n.liberarConductores([
      { solicitudId: "s1", conductorId: "c2" },
      { solicitudId: "s1", conductorId: "c5" },
    ]);
    assert.deepEqual(liberados, ["c2", "c5"]);
    assert.deepEqual(llamadas, [
      { conductor_id: "c2", solicitud_id: "s1" },
      { conductor_id: "c5", solicitud_id: "s1" },
    ]);
  });

  test("a M4 no se le avisa la aceptación del conductor (se da solo a M3)", () => {
    const n = crearNotificaciones({ clienteM4: { post: async () => {} }, clienteM6: { post: async () => {} }, rutas });
    assert.equal(n.conductorSeleccionado, undefined);
  });

  test("si falla con alguno, el error indica cuáles SÍ se liberaron", async () => {
    const clienteM4 = { post: async (ruta, cuerpo) => { if (cuerpo.conductor_id === "c2") throw new Error("M4 caído"); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await assert.rejects(
      () => n.liberarConductores([
        { solicitudId: "s", conductorId: "c1" },
        { solicitudId: "s", conductorId: "c2" },
      ]),
      (e) => /1 de 2/.test(e.message) && JSON.stringify(e.liberados) === JSON.stringify(["c1"])
    );
  });

  test("no se puede crear sin las rutas acordadas (no hay rutas inventadas)", () => {
    assert.throws(() => crearNotificaciones({ clienteM4: {}, clienteM6: {}, rutas: {} }), /rutas acordadas/);
  });
});
