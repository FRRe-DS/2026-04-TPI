const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearNotificaciones } = require("../../src/asignacion");

describe("Avisos a M3, M4 y M6", () => {
  const rutas = {
    m3EnviarOfertas: ({ solicitudId }) => `/m3/ofertas/${solicitudId}`,
    m6ConductorAsignado: ({ solicitudId }) => `/m6/${solicitudId}`,
    m4LiberarConductor: ({ conductorId }) => `/m4/${conductorId}`,
  };
  const vacio = { post: async () => {} };
  const crear = (clientes = {}) => crearNotificaciones({ clienteM3: vacio, clienteM4: vacio, clienteM6: vacio, rutas, ...clientes });

  test("manda claves de idempotencia estables por aviso", async () => {
    const llamadas = [];
    const falso = (nombre) => ({ post: async (ruta, cuerpo, op) => { llamadas.push({ nombre, ruta, cuerpo, clave: op.claveIdempotencia }); } });
    const n = crear({ clienteM4: falso("m4"), clienteM6: falso("m6") });
    await n.conductorAsignado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1" });
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2" }]);
    assert.deepEqual(llamadas.map((l) => [l.nombre, l.ruta, l.clave]), [
      ["m6", "/m6/s1", "asignacion:s1:o1"],
      ["m4", "/m4/c2", "liberar:s1:c2"],
    ]);
  });

  test("hacia M4 solo viaja el conductor y la solicitud: el mismo aviso para todos, sin motivo", async () => {
    const llamadas = [];
    const n = crear({ clienteM4: { post: async (ruta, cuerpo) => { llamadas.push(cuerpo); } } });
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
    assert.equal(crear().conductorSeleccionado, undefined);
  });

  test("si falla con alguno, el error indica cuáles SÍ se liberaron", async () => {
    const clienteM4 = { post: async (ruta, cuerpo) => { if (cuerpo.conductor_id === "c2") throw new Error("M4 caído"); } };
    await assert.rejects(
      () => crear({ clienteM4 }).liberarConductores([
        { solicitudId: "s", conductorId: "c1" },
        { solicitudId: "s", conductorId: "c2" },
      ]),
      (e) => /1 de 2/.test(e.message) && JSON.stringify(e.liberados) === JSON.stringify(["c1"])
    );
  });

  describe("envío de ofertas a M3", () => {
    const datos = {
      solicitudId: "s1",
      ofertas: [{ ofertaId: "o1", conductorId: "c1" }, { ofertaId: "o2", conductorId: "c2" }],
      origen: { latitud: -27.45, longitud: -58.98 },
      destino: { latitud: -27.47, longitud: -58.83 },
      tipoVehiculo: "AUTO",
      venceEn: new Date("2026-10-20T12:05:00Z"),
    };

    test("el cuerpo va en snake_case, una sola llamada con todas las ofertas", async () => {
      const llamadas = [];
      const n = crear({ clienteM3: { post: async (ruta, cuerpo, op) => { llamadas.push({ ruta, cuerpo, clave: op.claveIdempotencia }); } } });
      await n.enviarOfertas(datos);
      assert.equal(llamadas.length, 1);
      assert.equal(llamadas[0].ruta, "/m3/ofertas/s1");
      assert.deepEqual(llamadas[0].cuerpo, {
        solicitud_id: "s1",
        ofertas: [{ oferta_id: "o1", conductor_id: "c1" }, { oferta_id: "o2", conductor_id: "c2" }],
        origen_latitud: -27.45,
        origen_longitud: -58.98,
        destino_latitud: -27.47,
        destino_longitud: -58.83,
        tipo_vehiculo: "AUTO",
        vence_en: "2026-10-20T12:05:00.000Z",
      });
    });

    test("repetir el envío usa la misma clave de idempotencia, sin importar el orden de las ofertas", async () => {
      const claves = [];
      const n = crear({ clienteM3: { post: async (ruta, cuerpo, op) => { claves.push(op.claveIdempotencia); } } });
      await n.enviarOfertas(datos);
      await n.enviarOfertas({ ...datos, ofertas: [...datos.ofertas].reverse() });
      assert.equal(claves[0], claves[1]);
      assert.match(claves[0], /^ofertas:s1:[0-9a-f]{16}$/);
    });

    test("sin ofertas no se llama a M3; si M3 falla, el error le llega a quien envía (para reintentar)", async () => {
      let llamadas = 0;
      const n = crear({ clienteM3: { post: async () => { llamadas += 1; throw new Error("M3 caído"); } } });
      await assert.rejects(() => n.enviarOfertas({ ...datos, ofertas: [] }), /No hay ofertas/);
      assert.equal(llamadas, 0);
      await assert.rejects(() => n.enviarOfertas(datos), /M3 caído/);
    });
  });

  test("no se puede crear sin las rutas acordadas (no hay rutas inventadas)", () => {
    assert.throws(() => crearNotificaciones({ clienteM3: {}, clienteM4: {}, clienteM6: {}, rutas: {} }), /rutas acordadas/);
    assert.throws(() => crearNotificaciones({ clienteM4: {}, clienteM6: {}, rutas }), /clienteM3/);
  });
});
