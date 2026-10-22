const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { crearClienteHttp, ErrorServicioExterno } = require("../../src/comun");

function servidor(manejador) {
  return new Promise((resolver) => {
    const s = http.createServer(manejador);
    s.listen(0, "127.0.0.1", () => resolver({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const cerrar = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

describe("Cliente HTTP con timeout y reintentos (RNF-13)", () => {
  test("reintenta ante 500 y termina bien (POST con clave de idempotencia)", async () => {
    let llamadas = 0;
    const claves = [];
    const { s, url } = await servidor((req, res) => {
      llamadas += 1;
      claves.push(req.headers["idempotency-key"]);
      req.resume();
      if (llamadas < 3) { res.statusCode = 500; return res.end(); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const c = crearClienteHttp({ baseUrl: url, reintentos: 2, esperaBaseMs: 5 });
      assert.deepEqual(await c.post("/x", { a: 1 }, { claveIdempotencia: "k-1" }), { ok: true });
      assert.equal(llamadas, 3);
      assert.deepEqual([...new Set(claves)], ["k-1"], "todos los reintentos llevan la MISMA clave");
    } finally { await cerrar(s); }
  });

  test("un POST SIN clave de idempotencia no se reintenta (evita duplicar efectos)", async () => {
    let llamadas = 0;
    const { s, url } = await servidor((req, res) => { llamadas += 1; req.resume(); res.statusCode = 500; res.end(); });
    try {
      const c = crearClienteHttp({ baseUrl: url, reintentos: 3, esperaBaseMs: 5 });
      await assert.rejects(() => c.post("/x", {}), ErrorServicioExterno);
      assert.equal(llamadas, 1);
    } finally { await cerrar(s); }
  });

  test("un 4xx no se reintenta", async () => {
    let llamadas = 0;
    const { s, url } = await servidor((req, res) => { llamadas += 1; req.resume(); res.statusCode = 404; res.end(); });
    try {
      const c = crearClienteHttp({ baseUrl: url, reintentos: 3, esperaBaseMs: 5 });
      await assert.rejects(() => c.post("/x", {}, { claveIdempotencia: "k" }), (e) => e.estado === 404);
      assert.equal(llamadas, 1);
    } finally { await cerrar(s); }
  });

  test("si el servicio no responde, corta por timeout y agota los reintentos (no espera para siempre)", async () => {
    let llamadas = 0;
    const { s, url } = await servidor((req) => { llamadas += 1; req.resume(); /* nunca responde */ });
    try {
      const c = crearClienteHttp({ baseUrl: url, timeoutMs: 40, reintentos: 1, esperaBaseMs: 5 });
      const inicio = Date.now();
      await assert.rejects(() => c.post("/x", {}, { claveIdempotencia: "k" }), /Timeout/);
      assert.equal(llamadas, 2);
      assert.ok(Date.now() - inicio < 2000);
    } finally { await cerrar(s); }
  });

  test("servicio caído (conexión rechazada) -> ErrorServicioExterno", async () => {
    const c = crearClienteHttp({ baseUrl: "http://127.0.0.1:1", timeoutMs: 100, reintentos: 1, esperaBaseMs: 5 });
    await assert.rejects(() => c.get("/x"), ErrorServicioExterno);
  });
});
