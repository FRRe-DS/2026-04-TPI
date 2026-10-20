const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const jwt = require("jsonwebtoken");

const { leerConfig, crearLogger, crearVerificadorLocal, crearApp } = require("../../src/comun");
const { escenarioConOfertas } = require("../soporte/fakes");
const { crearRouterRespuesta } = require("../soporte/routerEjemplo");

const SECRETO = "un-secreto-de-prueba-con-mas-de-32-caracteres!!";
const OFERTA_1 = "11111111-1111-4111-8111-111111111111";
const OFERTA_2 = "22222222-2222-4222-8222-222222222222";
const OFERTA_JAMAS = "99999999-9999-4999-8999-999999999999";

function token(claims = {}, { secreto = SECRETO, opciones = {} } = {}) {
  return jwt.sign(
    { sub: "identidad-1", roles: ["CONDUCTOR"], conductor_id: "cond-1", ...claims },
    secreto,
    { algorithm: "HS256", expiresIn: "5m", ...opciones }
  );
}

function crearEntorno({ rateLimitMax = 1000, chequeos } = {}) {
  const config = leerConfig({
    JWT_SECRETO: SECRETO,
    JWT_CLAIM_CONDUCTOR: "conductor_id",
    RATE_LIMIT_MAX: String(rateLimitMax),
    BODY_LIMITE: "1kb",
  });
  const lineas = [];
  const destino = new Writable({ write(chunk, _enc, cb) { lineas.push(chunk.toString()); cb(); } });
  const logger = crearLogger({ nivel: "info", destino });

  const mundo = escenarioConOfertas(0);
  // Dos ofertas, de dos conductores distintos, sobre la misma solicitud (ids en formato UUID).
  mundo.estado.ofertas.set(OFERTA_1, { ofertaId: OFERTA_1, solicitudId: "sol-1", conductorId: "cond-1", estado: "PENDIENTE", venceEn: new Date("2026-10-20T12:05:00Z") });
  mundo.estado.ofertas.set(OFERTA_2, { ofertaId: OFERTA_2, solicitudId: "sol-1", conductorId: "cond-2", estado: "PENDIENTE", venceEn: new Date("2026-10-20T12:05:00Z") });

  const app = crearApp({
    config,
    logger,
    verificador: crearVerificadorLocal(config),
    chequeos,
    registrarRutas: (app, { requerirRol, validar }) =>
      app.use(crearRouterRespuesta({ deps: mundo.deps, requerirRol, validar })),
  });
  return { app, mundo, lineas };
}

let servidor, base, entorno;
async function levantar(opciones) {
  entorno = crearEntorno(opciones);
  await new Promise((resolver) => { servidor = entorno.app.listen(0, "127.0.0.1", resolver); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}
async function bajar() { await new Promise((resolver) => servidor.close(resolver)); }

const post = (ruta, { cuerpo, jwtToken, encabezados = {}, crudo } = {}) =>
  fetch(base + ruta, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}),
      ...encabezados,
    },
    body: crudo ?? JSON.stringify(cuerpo),
  });

describe("Configuración (RNF-06)", () => {
  test("falla al arrancar si falta el secreto o es corto", () => {
    assert.throws(() => leerConfig({}), /JWT_SECRETO/);
    assert.throws(() => leerConfig({ JWT_SECRETO: "corto" }), /32 caracteres/);
  });
  test("rechaza algoritmos no permitidos (incluido 'none')", () => {
    assert.throws(() => leerConfig({ JWT_SECRETO: SECRETO, JWT_ALGORITMO: "none" }), /JWT_ALGORITMO/);
  });
});

describe("Autenticación y autorización", () => {
  before(() => levantar());
  after(bajar);

  const cuerpoOk = { acepta: true };

  test("sin token -> 401 con WWW-Authenticate", async () => {
    const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    assert.equal((await r.json()).error.codigo, "NO_AUTENTICADO");
  });

  test("esquema distinto de Bearer o token mal armado -> 401", async () => {
    for (const valor of ["Basic abc", "Bearer", "Bearer a b", "token-pelado"]) {
      const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, encabezados: { authorization: valor } });
      assert.equal(r.status, 401, valor);
    }
  });

  test("firmado con otra clave -> 401", async () => {
    const t = token({}, { secreto: "otra-clave-distinta-de-mas-de-32-caracteres" });
    assert.equal((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: t })).status, 401);
  });

  test("token vencido -> 401", async () => {
    const t = token({}, { opciones: { expiresIn: "-1h" } });
    assert.equal((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: t })).status, 401);
  });

  test("algoritmo 'none' (token sin firma) -> 401", async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const sinFirma = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", roles: ["CONDUCTOR"], conductor_id: "cond-1" })}.`;
    assert.equal((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: sinFirma })).status, 401);
  });

  test("token sin identidad -> 401", async () => {
    const t = jwt.sign({ roles: ["CONDUCTOR"] }, SECRETO, { algorithm: "HS256", expiresIn: "5m" });
    assert.equal((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: t })).status, 401);
  });

  test("rol equivocado (cliente) -> 403", async () => {
    const t = token({ roles: ["CLIENTE"] });
    assert.equal((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: t })).status, 403);
  });

  test("conductor autenticado pero dueño de OTRA oferta -> 403 y no se modifica nada", async () => {
    const t = token({ conductor_id: "cond-2" }); // la oferta 1 es de cond-1
    const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: cuerpoOk, jwtToken: t });
    assert.equal(r.status, 403);
    assert.equal(entorno.mundo.estado.solicitudes.get("sol-1").estado, "BUSCANDO");
  });

  test("oferta inexistente -> 404", async () => {
    const r = await post(`/ofertas/${OFERTA_JAMAS}/respuesta`, { cuerpo: cuerpoOk, jwtToken: token() });
    assert.equal(r.status, 404);
  });
});

describe("Validación de entrada", () => {
  before(() => levantar());
  after(bajar);

  test("ofertaId que no es UUID -> 400 con detalle del campo", async () => {
    const r = await post(`/ofertas/no-es-uuid/respuesta`, { cuerpo: { acepta: true }, jwtToken: token() });
    assert.equal(r.status, 400);
    const cuerpo = await r.json();
    assert.equal(cuerpo.error.codigo, "VALIDACION");
    assert.ok(cuerpo.error.detalles.some((d) => d.campo === "params.ofertaId"));
  });

  test("acepta con tipo incorrecto o ausente -> 400", async () => {
    for (const cuerpo of [{ acepta: "si" }, {}]) {
      const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo, jwtToken: token() });
      assert.equal(r.status, 400);
    }
  });

  test("campos de más (mass assignment) -> 400", async () => {
    const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: { acepta: true, conductorId: "cond-2" }, jwtToken: token() });
    assert.equal(r.status, 400);
  });

  test("JSON roto -> 400 JSON_INVALIDO", async () => {
    const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { crudo: "{no es json", jwtToken: token() });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.codigo, "JSON_INVALIDO");
  });

  test("cuerpo demasiado grande -> 413", async () => {
    const r = await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: { acepta: true, relleno: "x".repeat(5000) }, jwtToken: token() });
    assert.equal(r.status, 413);
  });

  test("ruta inexistente -> 404 sin filtrar información interna", async () => {
    const r = await fetch(`${base}/no-existe`, { headers: { authorization: `Bearer ${token()}` } });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.codigo, "RUTA_INEXISTENTE");
  });
});

describe("Asignación única de punta a punta por HTTP", () => {
  before(() => levantar());
  after(bajar);

  test("gana el primero (200), el segundo recibe 409 YA_ASIGNADA y el primero puede repetir (200)", async () => {
    const ruta1 = `/ofertas/${OFERTA_1}/respuesta`;
    const ruta2 = `/ofertas/${OFERTA_2}/respuesta`;

    const primero = await post(ruta1, { cuerpo: { acepta: true }, jwtToken: token() });
    assert.equal(primero.status, 200);
    assert.equal((await primero.json()).resultado, "ASIGNADA");

    const segundo = await post(ruta2, { cuerpo: { acepta: true }, jwtToken: token({ conductor_id: "cond-2" }) });
    assert.equal(segundo.status, 409);
    assert.equal((await segundo.json()).error.codigo, "YA_ASIGNADA");

    const repetido = await post(ruta1, { cuerpo: { acepta: true }, jwtToken: token() });
    assert.equal(repetido.status, 200);
    assert.equal((await repetido.json()).repetida, true);
    assert.equal(entorno.mundo.espias.conductorAsignado.length, 1);
  });

  test("dos conductores aceptan a la vez por HTTP: un solo 200", async () => {
    // entorno nuevo para partir de BUSCANDO
    await bajar();
    await levantar();
    const [a, b] = await Promise.all([
      post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: { acepta: true }, jwtToken: token() }),
      post(`/ofertas/${OFERTA_2}/respuesta`, { cuerpo: { acepta: true }, jwtToken: token({ conductor_id: "cond-2" }) }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  });
});

describe("Endurecimiento y observabilidad", () => {
  before(() => levantar({ rateLimitMax: 5 }));
  after(bajar);

  test("/health responde sin token y trae cabeceras de seguridad", async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { estado: "ok" });
    assert.equal(r.headers.get("x-powered-by"), null);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  test("los logs llevan solicitudId y reqId, y NUNCA el token", async () => {
    const t = token();
    await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: { acepta: true }, jwtToken: t });
    await new Promise((r) => setTimeout(r, 20));
    const todo = entorno.lineas.join("");
    assert.ok(todo.includes('"solicitudId":"sol-1"'), "debe loguear el solicitudId");
    assert.ok(todo.includes('"reqId"'), "debe loguear el id de correlación");
    assert.ok(!todo.includes(t), "el token no debe aparecer en los logs");
    assert.ok(!todo.includes("Bearer"), "el header Authorization no debe aparecer");
  });

  test("un x-request-id con formato inseguro se reemplaza; uno válido se respeta", async () => {
    const malo = await fetch(`${base}/health`, { headers: { "x-request-id": "mal id con espacios" } });
    assert.notEqual(malo.headers.get("x-request-id"), "mal id con espacios");
    const bueno = await fetch(`${base}/health`, { headers: { "x-request-id": "abc-12345678" } });
    assert.equal(bueno.headers.get("x-request-id"), "abc-12345678");
  });

  test("límite de pedidos -> 429 al pasarse (y /health no cuenta para el límite)", async () => {
    for (let i = 0; i < 12; i++) assert.equal((await fetch(`${base}/health`)).status, 200);
    const estados = [];
    for (let i = 0; i < 12; i++) estados.push((await post(`/ofertas/${OFERTA_1}/respuesta`, { cuerpo: { acepta: false }, jwtToken: token() })).status);
    assert.ok(estados.includes(429), `debería haber algún 429: ${estados.join(",")}`);
  });
});

describe("/health/ready", () => {
  test("degradado (503) sin filtrar el mensaje del error interno", async () => {
    await levantar({ chequeos: { mysql: async () => { throw new Error("password=SECRETO host=10.0.0.5"); }, redis: async () => {} } });
    try {
      const r = await fetch(`${base}/health/ready`);
      assert.equal(r.status, 503);
      const texto = await r.text();
      assert.ok(!texto.includes("SECRETO") && !texto.includes("10.0.0.5"));
      const cuerpo = JSON.parse(texto);
      assert.deepEqual(cuerpo.componentes, { mysql: "falla", redis: "ok" });
    } finally { await bajar(); }
  });
});
