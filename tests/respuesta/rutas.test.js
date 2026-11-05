const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { leerConfig, crearLogger, crearVerificadorLocal, crearApp } = require("../../src/comun");
const { crearRouterRespuesta } = require("../../src/respuesta");
const { escenarioConOfertas } = require("../soporte/fakes");

const SECRETO = "un-secreto-de-prueba-con-mas-de-32-caracteres!!";
const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const O3 = "33333333-3333-4333-8333-333333333333";
const token = (conductor, roles = ["CONDUCTOR"]) =>
  jwt.sign({ sub: `i-${conductor}`, roles, conductor_id: conductor }, SECRETO, { algorithm: "HS256", expiresIn: "5m" });

let servidor, base, mundo;
async function levantar() {
  const config = leerConfig({ JWT_SECRETO: SECRETO, JWT_CLAIM_CONDUCTOR: "conductor_id", RATE_LIMIT_MAX: "1000" });
  mundo = escenarioConOfertas(0, { candidatosRestantes: 0 });
  const venceEn = new Date("2026-10-20T12:05:00Z");
  for (const [id, c] of [[O1, "cond-1"], [O2, "cond-2"], [O3, "cond-3"]]) {
    mundo.estado.ofertas.set(id, { ofertaId: id, solicitudId: "sol-1", conductorId: c, estado: "pendiente", venceEn });
  }
  const app = crearApp({
    config,
    logger: crearLogger({ nivel: "silent" }),
    verificador: crearVerificadorLocal(config),
    registrarRutas: (app, { requerirRol, validar }) =>
      app.use(crearRouterRespuesta({ deps: mundo.deps, requerirRol, validar })),
  });
  await new Promise((r) => { servidor = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}
const responder = (ofertaId, acepta, jwtToken) =>
  fetch(`${base}/ofertas/${ofertaId}/respuesta`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}) },
    body: JSON.stringify({ acepta }),
  });

describe("POST /ofertas/:id/respuesta: rechazo y aceptación de punta a punta", () => {
  before(levantar);
  after(() => new Promise((r) => servidor.close(r)));

  test("seguridad: sin token 401, rol equivocado 403, oferta ajena 403, oferta inexistente 404", async () => {
    assert.equal((await responder(O1, false)).status, 401);
    assert.equal((await responder(O1, false, token("cond-1", ["CLIENTE"]))).status, 403);
    assert.equal((await responder(O1, false, token("cond-2"))).status, 403);
    assert.equal((await responder("99999999-9999-4999-8999-999999999999", false, token("cond-1"))).status, 404);
    assert.equal(mundo.estado.ofertas.get(O1).estado, "pendiente", "nada cambió");
  });

  test("body inválido -> 400", async () => {
    const r = await fetch(`${base}/ofertas/${O1}/respuesta`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token("cond-1")}` },
      body: JSON.stringify({ acepta: "si", conductorId: "cond-2" }),
    });
    assert.equal(r.status, 400);
  });

  test("rechazar: 200, repetir: 200 con repetida:true, y no se expone el estado de la búsqueda", async () => {
    const a = await responder(O1, false, token("cond-1"));
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { resultado: "rechazada", solicitudId: "sol-1", repetida: false });
    const b = await responder(O1, false, token("cond-1"));
    assert.equal(b.status, 200);
    assert.equal((await b.json()).repetida, true);
  });

  test("aceptar una oferta que ya rechazaste -> 410 OFERTA_NO_VIGENTE", async () => {
    const r = await responder(O1, true, token("cond-1"));
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error.codigo, "oferta_no_vigente");
  });

  test("otro conductor acepta: 200; el primero ya rechazó, así que sigue vigente la de cond-3 hasta que gane cond-2", async () => {
    const a = await responder(O2, true, token("cond-2"));
    assert.equal(a.status, 200);
    assert.equal((await a.json()).resultado, "asignada");
    assert.equal(mundo.estado.ofertas.get(O3).estado, "cancelada");
  });

  test("rechazar o aceptar después de perder: 410; rechazar lo ya aceptado: 409 SOLICITUD_NO_DISPONIBLE / YA_ACEPTADA", async () => {
    assert.equal((await responder(O3, false, token("cond-3"))).status, 410);
    assert.equal((await responder(O3, true, token("cond-3"))).status, 409); // YA_ASIGNADA (YA_ASIGNADA: la solicitud ya tiene dueño)
    const r = await responder(O2, false, token("cond-2"));
    assert.equal(r.status, 409);
    const error = (await r.json()).error;
    assert.equal(error.codigo, "solicitud_no_disponible");
    assert.equal(error.motivo, "ya_aceptada");
  });
});
