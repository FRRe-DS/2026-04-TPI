// tests/asignacion/procesarCancelacion.test.js
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { procesarCancelacionSolicitud } = require("../../src/asignacion/procesarCancelacion");
const { escenarioConOfertas } = require("../soporte/fakes");

describe("Suite unitaria aislada: procesarCancelacionSolicitud y obtenerVehiculoConductor", () => {
  test("valida dependencias obligatorias", async () => {
    await assert.rejects(
      async () => procesarCancelacionSolicitud({ solicitudId: "sol-1" }, {}),
      /dependencias/i
    );
  });

  test("procesa cancelación exitosamente con escenario real de fakes", async () => {
    const m = escenarioConOfertas(2, { sinOferta: 2 });
    await m.cancelarSolicitud("sol-1");
    const r = await procesarCancelacionSolicitud({ solicitudId: "sol-1" }, m.deps);
    assert.deepEqual(r.avisosFallidos, []);
    assert.equal(m.espias.liberados.length, 4);
  });

  test("prueba unitaria aislada para obtenerVehiculoConductor / notificaciones", async () => {
    const { crearNotificaciones } = require("../../src/asignacion/notificaciones");
    const rutas = {
      m3EnviarOfertas: () => "/ofertas",
      m6ConductorAsignado: () => "/viajes",
      m4ReservarConductor: () => "/reservar",
      m4LiberarConductor: () => "/liberar",
    };

    let consultadoId = null;
    const notif = crearNotificaciones({
      clienteM3: { post: async () => {} },
      clienteM4: { post: async () => {} },
      clienteM6: { post: async () => ({ id: "trip-1" }) },
      rutas,
      obtenerVehiculoConductor: async (driverId) => {
        consultadoId = driverId;
        return { vehiculoId: "veh-999", tipoVehiculo: "AUTO" };
      },
      solicitudes: {
        obtenerDatosViaje: async () => ({
          clienteId: "cli-1",
          tipoVehiculo: "AUTO",
          origen: { latitud: 0, longitud: 0 },
          destino: { latitud: 1, longitud: 1 },
        }),
      },
    });

    const tripId = await notif.conductorAsignado({ solicitudId: "sol-1", conductorId: "cond-abc" });
    assert.equal(tripId, "trip-1");
    assert.equal(consultadoId, "cond-abc");
  });
});

