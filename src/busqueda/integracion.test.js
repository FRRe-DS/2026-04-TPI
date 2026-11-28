// src/busqueda/integracion.test.js
// Migrado de sintaxis Jest a node:test + node:assert/strict (Sprint 2).
// Verifica el comportamiento del cliente HTTP ante servicios caídos/lentos (RNF-13).
//
// Tests 1 y 2: usan un servidor HTTP real (node:http) para verificar que el cliente
//   lanza error cuando M3/M4 responden 500 o 503.
// Tests 3 y 4: usan fetchImpl mock (sin TCP) para verificar el caso de respuesta 200
//   y que el body enviado a M3 tiene el formato correcto.
//   Este enfoque es equivalente al usado en buscarCandidatos.test.js del proyecto.
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { crearClienteHttp } = require("../comun/clienteHttp");

// ─── Helpers para tests de falla (con servidor real) ─────────────────────────

function iniciarServidorPrueba(handler) {
  const servidor = http.createServer((req, res) => {
    req.resume();
    handler(req, res);
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () => {
      const { port } = servidor.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        cerrar: () =>
          new Promise((done) => {
            servidor.closeAllConnections?.();
            servidor.close(done);
          }),
      });
    });
  });
}

function crearClienteDeServicio(baseUrl, fetchImpl) {
  const opciones = { baseUrl, timeoutMs: 3000, reintentos: 0 };
  if (fetchImpl) opciones.fetchImpl = fetchImpl;
  const cliente = crearClienteHttp(opciones);
  return {
    async consultarM3(conductoresIds) {
      try {
        return await cliente.post("/conductores", { ids: conductoresIds });
      } catch (error) {
        throw new Error("Servicio M3 no disponible", { cause: error });
      }
    },
    async consultarM4(datosViaje) {
      try {
        return await cliente.post("/buscar", datosViaje);
      } catch (error) {
        throw new Error("Servicio M4 no disponible", { cause: error });
      }
    },
  };
}

// ─── Helper para tests de éxito (fetchImpl mock, sin TCP) ────────────────────

/**
 * Crea un fetchImpl mock que responde con `statusCode` y `body`.
 * Permite inspeccionar la última llamada con `ultimaLlamada()`.
 */
function crearFetchMock(statusCode, body) {
  let _url = null;
  let _opciones = null;
  async function fetchMock(url, opciones) {
    _url = url;
    _opciones = opciones;
    const texto = JSON.stringify(body);
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      async text() { return texto; },
    };
  }
  fetchMock.ultimaLlamada = () => ({ url: _url, opciones: _opciones });
  return fetchMock;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Pruebas de Integración - Manejo de servicios externos (RNF-13)", () => {

  // — Tests con servidor HTTP real (casos de error) —

  test("Debería arrojar error cuando M3 responde con falla (servidor caído / 500)", async () => {
    const srv = await iniciarServidorPrueba((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Caido" }));
    });
    try {
      const cliente = crearClienteDeServicio(srv.url);
      await assert.rejects(
        () => cliente.consultarM3([1, 2]),
        /Servicio M3 no disponible/
      );
    } finally {
      await srv.cerrar();
    }
  });

  test("Debería arrojar error cuando M4 responde con falla (503)", async () => {
    const srv = await iniciarServidorPrueba((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No disponible" }));
    });
    try {
      const cliente = crearClienteDeServicio(srv.url);
      await assert.rejects(
        () => cliente.consultarM4({ origen_latitud: -27.45, origen_longitud: -58.98 }),
        /Servicio M4 no disponible/
      );
    } finally {
      await srv.cerrar();
    }
  });

  // — Tests con fetchImpl mock (casos de éxito, sin TCP) —

  test("Debería devolver candidatos correctamente cuando M4 responde 200", async () => {
    const payload = {
      candidatos: [{ conductor_id: "c1", distancia_m: 150, tipo_vehiculo: "AUTO" }],
    };
    const fetchMock = crearFetchMock(200, payload);
    const cliente = crearClienteDeServicio("http://m4-mock", fetchMock);

    const respuesta = await cliente.consultarM4({ origen_latitud: -27.45, origen_longitud: -58.98 });

    assert.deepEqual(respuesta, payload);
  });

  test("Debería pasar el body correcto a M3 (ids como array)", async () => {
    const fetchMock = crearFetchMock(200, { conductores: [] });
    const cliente = crearClienteDeServicio("http://m3-mock", fetchMock);

    await cliente.consultarM3(["uid-1", "uid-2"]);

    const { opciones } = fetchMock.ultimaLlamada();
    const bodyEnviado = JSON.parse(opciones.body);
    assert.deepEqual(bodyEnviado, { ids: ["uid-1", "uid-2"] });
  });
});
