const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { leerConfig, crearLogger, crearVerificadorLocal, crearApp } = require("../../src/comun");
const { crearRouterConsulta, crearConsultasPrisma } = require("../../src/respuesta/rutasConsulta");

const SECRETO = "secreto-consultas-api-con-mas-de-32-caracteres!!";
const SOL_1 = "11111111-1111-4111-8111-111111111111";
const SOL_2 = "22222222-2222-4222-8222-222222222222";
const SOL_INEXISTENTE = "99999999-9999-4999-8999-999999999999";
const COND_1 = "aaaa1111-1111-4111-8111-111111111111";
const COND_2 = "bbbb2222-2222-4222-8222-222222222222";
const CLI_1 = "cccc1111-1111-4111-8111-111111111111";
const CLI_2 = "dddd2222-2222-4222-8222-222222222222";
const OF_1 = "eeee1111-1111-4111-8111-111111111111";
const OF_2 = "eeee2222-2222-4222-8222-222222222222";
const OF_3 = "eeee3333-3333-4333-8333-333333333333";

function firmar(sub, roles, extra = {}) {
  return jwt.sign({ sub, roles, ...extra }, SECRETO, { algorithm: "HS256", expiresIn: "5m" });
}

function crearConsultasEnMemoria() {
  const solicitudes = new Map([
    [SOL_1, { solicitudId: SOL_1, clienteId: CLI_1, estado: "asignada" }],
    [SOL_2, { solicitudId: SOL_2, clienteId: CLI_2, estado: "buscando" }],
  ]);

  const ofertas = [
    {
      ofertaId: OF_1,
      solicitudId: SOL_1,
      conductorId: COND_1,
      estado: "aceptada",
      enviadaEn: new Date("2026-11-20T10:00:00.000Z"),
      venceEn: new Date("2026-11-20T10:00:30.000Z"),
      respondidaEn: new Date("2026-11-20T10:00:10.000Z"),
    },
    {
      ofertaId: OF_2,
      solicitudId: SOL_1,
      conductorId: COND_2,
      estado: "cancelada",
      enviadaEn: new Date("2026-11-20T10:00:00.000Z"),
      venceEn: new Date("2026-11-20T10:00:30.000Z"),
      respondidaEn: null,
    },
    {
      ofertaId: OF_3,
      solicitudId: SOL_2,
      conductorId: COND_1,
      estado: "pendiente",
      enviadaEn: new Date("2026-11-20T10:05:00.000Z"),
      venceEn: new Date("2026-11-20T10:05:30.000Z"),
      respondidaEn: null,
    },
  ];

  // Cargados intencionalmente desordenados para verificar orden cronológico en el endpoint.
  const eventos = [
    {
      eventoId: "f0000000-0000-4000-8000-000000000003",
      solicitudId: SOL_1,
      ofertaId: OF_1,
      conductorId: COND_1,
      tipo: "ACEPTACION",
      ocurridoEn: new Date("2026-11-20T10:00:10.000Z"),
      detalle: "asignado",
    },
    {
      eventoId: "f0000000-0000-4000-8000-000000000001",
      solicitudId: SOL_1,
      ofertaId: null,
      conductorId: null,
      tipo: "BUSQUEDA",
      ocurridoEn: new Date("2026-11-20T09:59:55.000Z"),
      detalle: null,
    },
    {
      eventoId: "f0000000-0000-4000-8000-000000000002",
      solicitudId: SOL_1,
      ofertaId: OF_1,
      conductorId: COND_1,
      tipo: "OFERTA",
      ocurridoEn: new Date("2026-11-20T10:00:00.000Z"),
      detalle: null,
    },
  ];

  return {
    obtenerSolicitud: async (solicitudId) => solicitudes.get(solicitudId) ?? null,
    listarOfertasDeSolicitud: async (solicitudId) => ofertas.filter((o) => o.solicitudId === solicitudId),
    listarOfertasDeConductor: async (conductorId, { estado } = {}) =>
      ofertas.filter((o) => o.conductorId === conductorId && (!estado || o.estado === estado)),
    listarHistorialSolicitud: async (solicitudId) => eventos.filter((e) => e.solicitudId === solicitudId),
  };
}

let servidor;
let base;
let mysqlDebeFallar = false;

describe("Endpoints de consulta y auditoría (rutasConsulta) + /health", () => {
  before(async () => {
    const config = leerConfig({
      JWT_SECRETO: SECRETO,
      JWT_CLAIM_CONDUCTOR: "conductor_id",
      RATE_LIMIT_MAX: "1000",
    });
    const app = crearApp({
      config,
      logger: crearLogger({ nivel: "silent" }),
      verificador: crearVerificadorLocal(config),
      chequeos: {
        mysql: async () => {
          if (mysqlDebeFallar) throw new Error("mysql caído");
        },
      },
      registrarRutas: (app, { requerirRol, validar }) => {
        app.use(
          crearRouterConsulta({
            consultas: crearConsultasEnMemoria(),
            requerirRol,
            validar,
          })
        );
      },
    });
    await new Promise((resolve) => {
      servidor = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(() => new Promise((resolve) => servidor.close(resolve)));

  test("GET /health y GET /health/ready responden 200 ok y 503 degradado ante falla de MySQL", async () => {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { estado: "ok" });

    mysqlDebeFallar = false;
    const readyOk = await fetch(`${base}/health/ready`);
    assert.equal(readyOk.status, 200);
    assert.deepEqual(await readyOk.json(), { estado: "ok", componentes: { mysql: "ok" } });

    mysqlDebeFallar = true;
    const readyFail = await fetch(`${base}/health/ready`);
    assert.equal(readyFail.status, 503);
    assert.deepEqual(await readyFail.json(), { estado: "degradado", componentes: { mysql: "falla" } });
    mysqlDebeFallar = false;
  });

  test("GET /solicitudes/:solicitudId/ofertas valida autenticación, rol, UUID, 404 y devuelve ofertas mapeadas", async () => {
    assert.equal((await fetch(`${base}/solicitudes/${SOL_1}/ofertas`)).status, 401);

    const tokenCliente = firmar(CLI_1, ["CLIENTE"]);
    assert.equal(
      (await fetch(`${base}/solicitudes/${SOL_1}/ofertas`, { headers: { authorization: `Bearer ${tokenCliente}` } })).status,
      403
    );

    const tokenOperador = firmar("op-1", ["OPERADOR"]);
    assert.equal(
      (await fetch(`${base}/solicitudes/no-es-uuid/ofertas`, { headers: { authorization: `Bearer ${tokenOperador}` } })).status,
      400
    );

    assert.equal(
      (await fetch(`${base}/solicitudes/${SOL_INEXISTENTE}/ofertas`, { headers: { authorization: `Bearer ${tokenOperador}` } })).status,
      404
    );

    const res = await fetch(`${base}/solicitudes/${SOL_1}/ofertas`, {
      headers: { authorization: `Bearer ${tokenOperador}` },
    });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.length, 2);
    assert.deepEqual(cuerpo[0], {
      oferta_id: OF_1,
      solicitud_id: SOL_1,
      conductor_id: COND_1,
      estado: "aceptada",
      creada_en: "2026-11-20T10:00:00.000Z",
      vence_en: "2026-11-20T10:00:30.000Z",
      respondida_en: "2026-11-20T10:00:10.000Z",
    });
    assert.equal("respondida_en" in cuerpo[1], false);
  });

  test("GET /conductores/:conductorId/ofertas aplica titularidad, rol SERVICIO/OPERADOR y filtro ?estado=", async () => {
    const tokenCond1 = firmar("u-cond-1", ["CONDUCTOR"], { conductor_id: COND_1 });
    const tokenCond2 = firmar("u-cond-2", ["CONDUCTOR"], { conductor_id: COND_2 });
    const tokenServicio = firmar("m9-srv", ["SERVICIO"]);

    // Conductor 2 no puede ver ofertas de Conductor 1 -> 403
    const ajeno = await fetch(`${base}/conductores/${COND_1}/ofertas`, {
      headers: { authorization: `Bearer ${tokenCond2}` },
    });
    assert.equal(ajeno.status, 403);

    // Query estado inválido -> 400
    const estadoInvalido = await fetch(`${base}/conductores/${COND_1}/ofertas?estado=cualquiera`, {
      headers: { authorization: `Bearer ${tokenCond1}` },
    });
    assert.equal(estadoInvalido.status, 400);

    // Conductor 1 consulta todas sus ofertas -> 2 resultados
    const todas = await fetch(`${base}/conductores/${COND_1}/ofertas`, {
      headers: { authorization: `Bearer ${tokenCond1}` },
    });
    assert.equal(todas.status, 200);
    assert.equal((await todas.json()).length, 2);

    // Servicio consulta filtrando ?estado=pendiente -> 1 resultado
    const filtradas = await fetch(`${base}/conductores/${COND_1}/ofertas?estado=pendiente`, {
      headers: { authorization: `Bearer ${tokenServicio}` },
    });
    assert.equal(filtradas.status, 200);
    const lista = await filtradas.json();
    assert.equal(lista.length, 1);
    assert.equal(lista[0].oferta_id, OF_3);
    assert.equal(lista[0].estado, "pendiente");
  });

  test("GET /solicitudes/:solicitudId/historial exige titularidad o rol privilegiado, 404 y orden cronológico", async () => {
    const tokenCli1 = firmar(CLI_1, ["CLIENTE"]);
    const tokenCli2 = firmar(CLI_2, ["CLIENTE"]);
    const tokenAdmin = firmar("admin-1", ["ADMINISTRADOR"]);

    // Cliente 2 intenta ver historial de SOL_1 (de Cliente 1) -> 403
    assert.equal(
      (await fetch(`${base}/solicitudes/${SOL_1}/historial`, { headers: { authorization: `Bearer ${tokenCli2}` } })).status,
      403
    );

    // Solicitud inexistente -> 404
    assert.equal(
      (await fetch(`${base}/solicitudes/${SOL_INEXISTENTE}/historial`, { headers: { authorization: `Bearer ${tokenAdmin}` } })).status,
      404
    );

    // Cliente titular obtiene historial ordenado cronológicamente
    const res = await fetch(`${base}/solicitudes/${SOL_1}/historial`, {
      headers: { authorization: `Bearer ${tokenCli1}` },
    });
    assert.equal(res.status, 200);
    const historial = await res.json();
    assert.deepEqual(
      historial.map((e) => e.tipo),
      ["BUSQUEDA_INICIADA", "OFERTA_EMITIDA", "OFERTA_ACEPTADA"]
    );
    assert.deepEqual(
      historial.map((e) => e.fecha),
      [
        "2026-11-20T09:59:55.000Z",
        "2026-11-20T10:00:00.000Z",
        "2026-11-20T10:00:10.000Z",
      ]
    );
    assert.equal(historial[2].detalle, "asignado");
    assert.equal("oferta_id" in historial[0], false);
  });

  test("crearConsultasPrisma consulta el cliente Prisma con los selects y filtros esperados", async () => {
    const llamadas = [];
    const prismaFalso = {
      solicitud: {
        findUnique: async (args) => {
          llamadas.push(["solicitud.findUnique", args]);
          return { idSolicitud: SOL_1, idCliente: CLI_1, estado: "asignada" };
        },
      },
      oferta: {
        findMany: async (args) => {
          llamadas.push(["oferta.findMany", args]);
          return [];
        },
      },
      evento: {
        findMany: async (args) => {
          llamadas.push(["evento.findMany", args]);
          return [];
        },
      },
    };
    const consultas = crearConsultasPrisma(prismaFalso);
    const s = await consultas.obtenerSolicitud(SOL_1);
    assert.deepEqual(s, { solicitudId: SOL_1, clienteId: CLI_1, estado: "asignada" });
    await consultas.listarOfertasDeSolicitud(SOL_1);
    await consultas.listarOfertasDeConductor(COND_1, { estado: "pendiente" });
    await consultas.listarHistorialSolicitud(SOL_1);
    assert.equal(llamadas.length, 4);
    assert.deepEqual(llamadas[2][1].where, { conductorId: COND_1, estado: "pendiente" });
  });
});
