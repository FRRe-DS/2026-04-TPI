// tests/clientes/clienteM8.test.js
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { crearClienteHttp } = require("../../src/comun/clienteHttp");
const { informarEventoM8 } = require("../../src/clientes/clienteM8");

function servidor(manejador) {
  return new Promise((resolver) => {
    const s = http.createServer(manejador);
    s.listen(0, "127.0.0.1", () => resolver({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const cerrar = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

describe("Cliente M8", () => {
  test("informarEventoM8 envía POST a /api/v1/eventos con idempotency-key", async () => {
    let recibido = null;
    let idempotencyKeyHeader = null;

    const { s, url } = await servidor((req, res) => {
      idempotencyKeyHeader = req.headers["idempotency-key"];
      let cuerpo = "";
      req.on("data", (chunk) => { cuerpo += chunk; });
      req.on("end", () => {
        recibido = JSON.parse(cuerpo);
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ eventoId: recibido.eventoId, recibidoEn: new Date().toISOString() }));
      });
    });

    try {
      const clienteM8Mock = crearClienteHttp({ baseUrl: url, tokenPorDefecto: "token-test" });
      const evento = {
        eventoId: "7b6e2f10-3c1d-4a8e-9f55-1d2c3b4a5e01",
        tipo: "SOLICITUD_CANCELADA",
        origen: "M5",
        ocurridoEn: new Date().toISOString(),
        solicitudId: "550e8400-e29b-41d4-a716-446655440000",
        destinatarios: [{ usuarioId: "uuid", rol: "CLIENTE", email: "test@ejemplo.com" }]
      };

      const res = await informarEventoM8(clienteM8Mock, evento);

      assert.equal(res.eventoId, evento.eventoId);
      assert.equal(idempotencyKeyHeader, evento.eventoId);
      assert.deepEqual(recibido, evento);
    } finally {
      await cerrar(s);
    }
  });
});
