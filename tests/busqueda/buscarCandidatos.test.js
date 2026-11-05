const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  crearBuscadorCandidatos,
  construirPedidoM4,
  ErrorBusquedaCandidatos,
  ErrorDatosSolicitud,
} = require("../../src/busqueda/busquedaService");

const solicitud = {
  solicitudId: "11111111-1111-4111-8111-111111111111",
  origen: { latitud: -27.45, longitud: -58.98 },
  destino: { lat: -27.47, lng: -58.83 }, // también se acepta el formato de la clase Coordenada
  tipoVehiculo: "AUTO",
};

function clienteFalso(respuestas) {
  const llamadas = [];
  return {
    llamadas,
    async consultarM4(pedido) {
      llamadas.push(pedido);
      const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const buscador = (cliente, extra = {}) =>
  crearBuscadorCandidatos({ clienteM4: cliente, dormir: async () => {}, ...extra });

describe("Búsqueda de candidatos (contrato M4)", () => {
  test("le manda a M4 solicitud_id y las cuatro coordenadas, en snake_case y como números", async () => {
    const m4 = clienteFalso([{ candidatos: [] }]);
    await buscador(m4).buscar(solicitud);
    assert.deepEqual(m4.llamadas, [
      {
        solicitud_id: solicitud.solicitudId,
        origen_latitud: -27.45,
        origen_longitud: -58.98,
        destino_latitud: -27.47,
        destino_longitud: -58.83,
      },
    ]);
  });

  test("no manda radio ni límite ni exclusiones: eso lo decide M4", () => {
    const pedido = construirPedidoM4(solicitud);
    assert.deepEqual(Object.keys(pedido).sort(), [
      "destino_latitud", "destino_longitud", "origen_latitud", "origen_longitud", "solicitud_id",
    ]);
  });

  test("lista vacía = no hay conductores: se devuelve [] y NO se reintenta", async () => {
    const m4 = clienteFalso([{ candidatos: [] }]);
    assert.deepEqual(await buscador(m4).buscar(solicitud), []);
    assert.equal(m4.llamadas.length, 1);
  });

  test("error o timeout de M4: repite el intento y devuelve el resultado cuando responde", async () => {
    const m4 = clienteFalso([
      new Error("Servicio M4 no disponible"),
      new Error("Servicio M4 no disponible"),
      { candidatos: [{ conductor_id: "c1", distancia_m: 300, tipo_vehiculo: "AUTO" }] },
    ]);
    const r = await buscador(m4).buscar(solicitud);
    assert.equal(m4.llamadas.length, 3);
    assert.deepEqual(r.map((c) => c.conductorId), ["c1"]);
  });

  test("si M4 sigue fallando NO devuelve []: lanza ErrorBusquedaCandidatos (no se declara agotada)", async () => {
    const m4 = clienteFalso([new Error("Servicio M4 no disponible")]);
    await assert.rejects(
      () => buscador(m4, { intentos: 3 }).buscar(solicitud),
      (e) => e instanceof ErrorBusquedaCandidatos && e.intentos === 3
    );
    assert.equal(m4.llamadas.length, 3);
  });

  test("una respuesta sin candidatos[] es un error, no una lista vacía", async () => {
    const m4 = clienteFalso([{}, null, { candidatos: "nada" }]);
    await assert.rejects(() => buscador(m4, { intentos: 3 }).buscar(solicitud), ErrorBusquedaCandidatos);
  });

  test("ordena por distancia_m, filtra el tipo de vehículo y NO filtra por radio", async () => {
    const m4 = clienteFalso([
      {
        candidatos: [
          { conductor_id: "lejos", distancia_m: 48000, tipo_vehiculo: "AUTO" },
          { conductor_id: "moto", distancia_m: 50, tipo_vehiculo: "MOTO" },
          { conductor_id: "cerca", distancia_m: 120.5, tipo_vehiculo: "auto" },
          { distancia_m: 10, tipo_vehiculo: "AUTO" }, // sin conductor_id: se descarta
        ],
      },
    ]);
    const r = await buscador(m4).buscar(solicitud);
    assert.deepEqual(r.map((c) => c.conductorId), ["cerca", "lejos"]);
    assert.equal(r[0].distanciaM, 120.5);
  });

  test("si el mismo conductor viene repetido se queda con la menor distancia", async () => {
    const m4 = clienteFalso([
      {
        candidatos: [
          { conductor_id: "c1", distancia_m: 900, tipo_vehiculo: "AUTO" },
          { conductor_id: "c1", distancia_m: 400, tipo_vehiculo: "AUTO" },
        ],
      },
    ]);
    const r = await buscador(m4).buscar(solicitud);
    assert.deepEqual(r.map((c) => [c.conductorId, c.distanciaM]), [["c1", 400]]);
  });

  test("guarda la lista que devolvió M4 (M4 ya reservó a esos conductores), con su ronda", async () => {
    const guardados = [];
    const candidatos = { guardar: async (x) => { guardados.push(x); } };
    const m4 = clienteFalso([
      { candidatos: [
        { conductor_id: "c2", distancia_m: 500, tipo_vehiculo: "AUTO" },
        { conductor_id: "c1", distancia_m: 100, tipo_vehiculo: "AUTO" },
      ] },
    ]);
    await buscador(m4, { candidatos }).buscar(solicitud);
    await buscador(m4, { candidatos }).buscar(solicitud, { ronda: 2 });
    assert.equal(guardados.length, 2);
    assert.equal(guardados[0].solicitudId, solicitud.solicitudId);
    assert.equal(guardados[0].ronda, 1);
    assert.deepEqual(guardados[0].lista.map((c) => c.conductorId), ["c1", "c2"], "se guarda en el orden de la lista");
    assert.equal(guardados[1].ronda, 2);
  });

  test("no guarda nada si la lista viene vacía o si M4 falla", async () => {
    const guardados = [];
    const candidatos = { guardar: async (x) => { guardados.push(x); } };
    await buscador(clienteFalso([{ candidatos: [] }]), { candidatos }).buscar(solicitud);
    await assert.rejects(() => buscador(clienteFalso([new Error("caído")]), { candidatos, intentos: 2 }).buscar(solicitud));
    assert.equal(guardados.length, 0);
  });

  test("coordenadas inválidas o sin solicitudId: se rechaza antes de llamar a M4", async () => {
    const m4 = clienteFalso([{ candidatos: [] }]);
    const b = buscador(m4);
    await assert.rejects(() => b.buscar({ ...solicitud, origen: { latitud: 200, longitud: 0 } }), ErrorDatosSolicitud);
    await assert.rejects(() => b.buscar({ ...solicitud, destino: { latitud: 0, longitud: "x" } }), ErrorDatosSolicitud);
    await assert.rejects(() => b.buscar({ ...solicitud, solicitudId: "" }), ErrorDatosSolicitud);
    assert.equal(m4.llamadas.length, 0);
  });
});
