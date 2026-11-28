const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { crearNotificaciones } = require("../../src/asignacion");

describe("Avisos a M3, M4 y M6", () => {
  // Las rutas de M3 y M6 no dependen de la solicitud (como en src/main.js); las de M4 llevan al
  // conductor en la ruta.
  const rutas = {
    m3EnviarOfertas: () => "/m3/ofertas",
    m6ConductorAsignado: () => "/m6/viajes",
    m4ReservarConductor: ({ conductorId }) => `/m4/reserva/${conductorId}`,
    m4LiberarConductor: ({ conductorId }) => `/m4/${conductorId}`,
  };
  const vacio = { post: async () => {} };
  const crear = (clientes = {}) => crearNotificaciones({ clienteM3: vacio, clienteM4: vacio, clienteM6: vacio, rutas, ...clientes });

  // Datos de la solicitud que M5 le pasa a M6 para crear el viaje.
  const DATOS_VIAJE = {
    clienteId: "cli-1",
    tipoVehiculo: "AUTO",
    origen: { latitud: -27.45, longitud: -58.98 },
    destino: { latitud: -27.47, longitud: -58.83 },
  };

  test("manda claves de idempotencia estables por aviso", async () => {
    const llamadas = [];
    const falso = (nombre, respuesta) => ({
      post: async (ruta, cuerpo, op) => { llamadas.push({ nombre, ruta, cuerpo, clave: op.claveIdempotencia }); return respuesta; },
    });
    const n = crear({ clienteM4: falso("m4"), clienteM6: falso("m6", { id: "trip-1" }) });
    const asignar = () => n.conductorAsignado({ solicitudId: "s1", conductorId: "c1", ofertaId: "o1", solicitud: DATOS_VIAJE, vehiculoId: "v1" });
    assert.equal(await asignar(), "trip-1");
    assert.equal(await asignar(), "trip-1"); // repetir el aviso a M6 usa la misma clave: M6 no crea otro viaje
    await n.liberarConductores([{ solicitudId: "s1", conductorId: "c2" }]);
    assert.deepEqual(llamadas.map((l) => [l.nombre, l.ruta, l.clave]), [
      ["m6", "/m6/viajes", "viaje:s1"],
      ["m6", "/m6/viajes", "viaje:s1"],
      ["m4", "/m4/c2", "liberar:s1:c2"],
    ]);
  });

  // Contrato oficial de M4 (POST /api/v1/conductores/{conductor_id}/reserva): el conductor va en la
  // ruta y el cuerpo lleva estado_temporal y solicitud_id (los dos obligatorios).
  test("hacia M4 va el mismo aviso para todos, de a un conductor por llamada (el conductor en la ruta)", async () => {
    const llamadas = [];
    const n = crear({ clienteM4: { post: async (ruta, cuerpo) => { llamadas.push({ ruta, cuerpo }); } } });
    const liberados = await n.liberarConductores([
      { solicitudId: "s1", conductorId: "c2" },
      { solicitudId: "s1", conductorId: "c5" },
    ]);
    assert.deepEqual(liberados, ["c2", "c5"]);
    assert.deepEqual(llamadas, [
      { ruta: "/m4/c2", cuerpo: { estado_temporal: "LIBERADO", solicitud_id: "s1" } },
      { ruta: "/m4/c5", cuerpo: { estado_temporal: "LIBERADO", solicitud_id: "s1" } },
    ]);
  });

  describe("reserva de un conductor en M4 (antes de ofertarle)", () => {
    test("hacia M4 va el conductor en la ruta, con una clave de idempotencia estable", async () => {
      const llamadas = [];
      const n = crear({ clienteM4: { post: async (ruta, cuerpo, op) => { llamadas.push({ ruta, cuerpo, clave: op.claveIdempotencia }); } } });
      assert.equal(await n.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), true);
      assert.deepEqual(llamadas, [
        { ruta: "/m4/reserva/c1", cuerpo: { estado_temporal: "RESERVADO", solicitud_id: "s1" }, clave: "reservar:s1:c1" },
      ]);
    });

    test("409 de M4 (otra solicitud lo reservó antes) = no reservado, sin lanzar error", async () => {
      const n = crear({ clienteM4: { post: async () => { throw Object.assign(new Error("Respuesta 409"), { estado: 409 }); } } });
      assert.equal(await n.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), false);
    });

    test("cualquier otro error de M4 se lanza (quien llama decide)", async () => {
      const n = crear({ clienteM4: { post: async () => { throw Object.assign(new Error("Respuesta 503"), { estado: 503 }); } } });
      await assert.rejects(() => n.reservarConductor({ solicitudId: "s1", conductorId: "c1" }), /503/);
    });
  });

  test("a M4 no se le avisa la aceptación del conductor (se da solo a M3)", () => {
    assert.equal(crear().conductorSeleccionado, undefined);
  });

  test("si falla con alguno, el error indica cuáles SÍ se liberaron", async () => {
    const clienteM4 = { post: async (ruta) => { if (ruta === "/m4/c2") throw new Error("M4 caído"); } };
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

    // Contrato acordado con M3 (POST /api/v1/integration/m5/offers): una llamada por oferta, con
    // los campos en inglés y las direcciones armadas con las coordenadas.
    test("una llamada por oferta, con el contrato de M3", async () => {
      const llamadas = [];
      const n = crear({ clienteM3: { post: async (ruta, cuerpo, op) => { llamadas.push({ ruta, cuerpo, clave: op.claveIdempotencia }); } } });
      await n.enviarOfertas(datos);
      assert.equal(llamadas.length, 2);
      assert.ok(llamadas.every((l) => l.ruta === "/m3/ofertas"));
      assert.deepEqual(llamadas.map((l) => l.cuerpo), [
        {
          offerId: "o1",
          driverId: "c1",
          requestId: "s1",
          pickupAddress: "-27.45, -58.98",
          destinationAddress: "-27.47, -58.83",
          vehicleType: "AUTO",
          expiresAt: "2026-10-20T12:05:00.000Z",
        },
        {
          offerId: "o2",
          driverId: "c2",
          requestId: "s1",
          pickupAddress: "-27.45, -58.98",
          destinationAddress: "-27.47, -58.83",
          vehicleType: "AUTO",
          expiresAt: "2026-10-20T12:05:00.000Z",
        },
      ]);
    });

    test("repetir el envío usa las mismas claves de idempotencia, sin importar el orden de las ofertas", async () => {
      const claves = [];
      const n = crear({ clienteM3: { post: async (ruta, cuerpo, op) => { claves.push(op.claveIdempotencia); } } });
      await n.enviarOfertas(datos);
      await n.enviarOfertas({ ...datos, ofertas: [...datos.ofertas].reverse() });
      const primera = claves.slice(0, 2).sort();
      const segunda = claves.slice(2).sort();
      assert.deepEqual(primera, segunda);
      assert.match(primera[0], /^ofertas:s1:[0-9a-f]{16}:o1$/);
      assert.match(primera[1], /^ofertas:s1:[0-9a-f]{16}:o2$/);
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
