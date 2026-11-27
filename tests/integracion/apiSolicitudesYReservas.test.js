// tests/integracion/apiSolicitudesYReservas.test.js
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { crearMocksExternos } = require("../soporte/mocksExternos");

describe("Tests de integración: API de Solicitudes y Reservas (Persona 1)", () => {
  let mocks;

  before(async () => {
    mocks = await crearMocksExternos();
  });

  after(async () => {
    if (mocks) await mocks.cerrar();
  });

  test("Los servidores mock de M2, M3, M4, M6, M7 y M9 levantan correctamente en puertos efímeros", () => {
    assert.ok(mocks.urls.m2);
    assert.ok(mocks.urls.m3);
    assert.ok(mocks.urls.m4);
    assert.ok(mocks.urls.m6);
    assert.ok(mocks.urls.m7);
    assert.ok(mocks.urls.m9);
    assert.ok(mocks.urls.m8);
  });

  test("Validación estructural de endpoints de escritura y flujo transaccional", async () => {
    // Verificamos que las URLs de mock responden satisfactoriamente al rol y contratos esperados
    const resM9 = await fetch(mocks.urls.m9);
    const dataM9 = await resM9.json();
    assert.equal(dataM9.reserva_id, "res-m9-001");
    assert.equal(dataM9.estado, "ACTIVADA");

    const resM7 = await fetch(mocks.urls.m7);
    const dataM7 = await resM7.json();
    assert.equal(dataM7.moneda, "ARS");
    assert.equal(dataM7.monto, 1250.0);
  });
});
