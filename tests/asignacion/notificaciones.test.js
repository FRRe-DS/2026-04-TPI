const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearNotificaciones } = require("../../src/asignacion");

describe("Avisos a M3, M4 y M6", () => {
  const rutas = {
    m3EnviarOfertas: () => "/m3/ofertas",
    m6ConductorAsignado: () => "/m6/viajes",
    m4ReservarConductor: ({ conductorId }) => `/m4/reserva/${conductorId}`,
    m4LiberarConductor: ({ conductorId }) => `/m4/${conductorId}`,
  };
  const vacio = { post: async () => ({ id: "trip-1" }) };
  const crear = (clientes = {}) => crearNotificaciones({ clienteM3: vacio, clienteM4: vacio, clienteM6: vacio, rutas, ...clientes });
  const solBase = {
    solicitudId: "s1",
    clienteId: "cli-1",
    origen: { latitud: -27.45, longitud: -58.98 },
    destino: { latitud: -27.47, longitud: -58.83 },
    tipoVehiculo: "AUTO",
  };

  test("manda claves de idempotencia estables por aviso", async () => {
    const reqs = [];
    const falso = (nom) => ({
      post: async (ruta, cuerpo, op) => {
        reqs.push({ nom, ruta, cuerpo, clave: op.claveIdempotencia });
        return { id: "trip-1" };
      },
    });
    const notif = crear({ clienteM4: falso("m4"), clienteM6: falso("m6") });
    await notif.conductorAsignado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1", solicitud: solBase, vehiculoId: "veh-1" });
    await notif.liberarConductores([{ solicitudId: "s1", conductorId: "c2" }]);
    assert.deepEqual(reqs.map((l) => [l.nom, l.ruta, l.clave]), [
      ["m6", "/m6/viajes", "viaje:s1"],
      ["m4", "/m4/c2", "liberar:s1:c2"],
    ]);
  });

  test("hacia M4 viaja estado_temporal LIBERADO y solicitud_id de a uno", async () => {
    const reqs = [];
    const notif = crear({ clienteM4: { post: async (ruta, cuerpo) => { reqs.push(cuerpo); } } });
    const lib = await notif.liberarConductores([
      { solicitudId: "s1", conductorId: "c2" },
      { solicitudId: "s1", conductorId: "c5" },
    ]);
    assert.deepEqual(lib, ["c2", "c5"]);
    assert.deepEqual(reqs, [
      { estado_temporal: "LIBERADO", solicitud_id: "s1" },
      { estado_temporal: "LIBERADO", solicitud_id: "s1" },
    ]);
  });

  describe("reserva de un conductor en M4 (antes de ofertarle)", () => {
    test("hacia M4 viaja estado_temporal RESERVADO, con una clave de idempotencia estable", async () => {
      const reqs = [];
      const notif = crear({ clienteM4: { post: async (ruta, cuerpo, op) => { reqs.push({ ruta, cuerpo, clave: op.claveIdempotencia }); } } });
      assert.equal(await notif.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), true);
      assert.deepEqual(reqs, [{ ruta: "/m4/reserva/c1", cuerpo: { estado_temporal: "RESERVADO", solicitud_id: "s1" }, clave: "reservar:s1:c1" }]);
    });

    test("409 de M4 (otra solicitud lo reservó antes) = no reservado, sin lanzar error", async () => {
      const notif = crear({ clienteM4: { post: async () => { throw Object.assign(new Error("Respuesta 409"), { estado: 409 }); } } });
      assert.equal(await notif.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), false);
    });

    test("cualquier otro error de M4 se lanza (quien llama decide)", async () => {
      const notif = crear({ clienteM4: { post: async () => { throw Object.assign(new Error("Respuesta 503"), { estado: 503 }); } } });
      await assert.rejects(() => notif.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), /503/);
    });
  });

  test("a M4 no se le avisa la aceptación del conductor (se da solo a M3)", () => {
    assert.equal(crear().conductorSeleccionado, undefined);
  });

  test("si falla con alguno, el error indica cuáles SÍ se liberaron", async () => {
    const clienteM4 = { post: async (ruta) => { if (ruta.endsWith("/c2")) throw new Error("M4 caído"); } };
    await assert.rejects(
      () => crear({ clienteM4 }).liberarConductores([
        { solicitudId: "s", conductorId: "c1" },
        { solicitudId: "s", conductorId: "c2" },
      ]),
      (err) => /1 de 2/.test(err.message) && JSON.stringify(err.liberados) === JSON.stringify(["c1"])
    );
  });

  describe("envío de ofertas a M3", () => {
    const dto = {
      solicitudId: "s1",
      ofertas: [{ ofertaId: "o1", conductorId: "c1" }, { ofertaId: "o2", conductorId: "c2" }],
      origen: { latitud: -27.45, longitud: -58.98 },
      destino: { latitud: -27.47, longitud: -58.83 },
      tipoVehiculo: "AUTO",
      venceEn: new Date("2026-10-20T12:05:00Z"),
    };

    test("el cuerpo va en camelCase, una llamada por oferta", async () => {
      const reqs = [];
      const notif = crear({ clienteM3: { post: async (ruta, cuerpo, op) => { reqs.push({ ruta, cuerpo, clave: op.claveIdempotencia }); } } });
      await notif.enviarOfertas(dto);
      assert.equal(reqs.length, 2);
      assert.equal(reqs[0].ruta, "/m3/ofertas");
      assert.deepEqual(reqs[0].cuerpo, {
        offerId: "o1",
        driverId: "c1",
        requestId: "s1",
        pickupAddress: "-27.45, -58.98",
        destinationAddress: "-27.47, -58.83",
        vehicleType: "AUTO",
        expiresAt: "2026-10-20T12:05:00.000Z",
      });
    });

    test("repetir el envío usa las mismas claves de idempotencia por oferta", async () => {
      const clv1 = [];
      const clv2 = [];
      const n1 = crear({ clienteM3: { post: async (_r, _c, op) => { clv1.push(op.claveIdempotencia); } } });
      const n2 = crear({ clienteM3: { post: async (_r, _c, op) => { clv2.push(op.claveIdempotencia); } } });
      await n1.enviarOfertas(dto);
      await n2.enviarOfertas({ ...dto, ofertas: [...dto.ofertas].reverse() });
      assert.deepEqual(clv1.sort(), clv2.sort());
    });

    test("sin ofertas no se llama a M3; si M3 falla, el error le llega a quien envía (para reintentar)", async () => {
      let cant = 0;
      const notif = crear({ clienteM3: { post: async () => { cant += 1; throw new Error("M3 caído"); } } });
      await assert.rejects(() => notif.enviarOfertas({ ...dto, ofertas: [] }), /No hay ofertas/);
      assert.equal(cant, 0);
      await assert.rejects(() => notif.enviarOfertas(dto), /M3 caído/);
    });
  });

  test("no se puede crear sin las rutas acordadas (no hay rutas inventadas)", () => {
    assert.throws(() => crearNotificaciones({ clienteM3: {}, clienteM4: {}, clienteM6: {}, rutas: {} }), /rutas acordadas/);
    assert.throws(() => crearNotificaciones({ clienteM4: {}, clienteM6: {}, rutas }), /clienteM3/);
  });
});