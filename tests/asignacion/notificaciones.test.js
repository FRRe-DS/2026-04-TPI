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
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2", ofertaId: "o2", motivo: "OFERTA_PERDIDA" }]);
    assert.deepEqual(llamadas.map((l) => [l.nombre, l.ruta, l.clave]), [
      ["m6", "/m6/s1", "asignacion:s1:o1"],
      ["m4", "/m4/c2", "liberar:o2"],
    ]);
  });

  test("si falla la liberación de alguno, lo informa (para reintentarlo)", async () => {
    const clienteM4 = { post: async (ruta) => { if (ruta.endsWith("c2")) throw new Error("M4 caído"); } };
    const n = crearNotificaciones({ clienteM4, clienteM6: { post: async () => {} }, rutas });
    await assert.rejects(
      () => n.liberarConductores([
        { solicitudId: "s", conductorId: "c1", ofertaId: "o1", motivo: "x" },
        { solicitudId: "s", conductorId: "c2", ofertaId: "o2", motivo: "x" },
      ]),
      /1 de 2/
    );
  });

  test("no se puede crear sin las rutas acordadas (no hay rutas inventadas)", () => {
    assert.throws(() => crearNotificaciones({ clienteM4: {}, clienteM6: {}, rutas: {} }), /rutas acordadas/);
  });
});
