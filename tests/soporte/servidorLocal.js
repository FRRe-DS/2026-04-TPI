// SERVIDOR DE PRUEBA LOCAL: la app real (seguridad, validación, asignación única) con los
// puertos de A y B reemplazados por versiones TEMPORALES en memoria (tests/soporte/fakes.js).
// No usa MySQL ni Redis ni M1/M4/M6. Sirve para probar a mano con curl o Postman.
//
//   node tests/soporte/servidorLocal.js
//
// Cuando A y Azul tengan sus funciones reales, se cambian los fakes por las reales en `deps`
// y el resto queda igual.
const jwt = require("jsonwebtoken");
const { leerConfig, crearLogger, crearVerificadorLocal, crearApp, ROLES } = require("../../src/comun");
const { procesarCancelacionSolicitud } = require("../../src/asignacion");
const { escenarioConOfertas } = require("./fakes");
const { crearRouterRespuesta } = require("./routerEjemplo");

const SECRETO = process.env.JWT_SECRETO ?? "secreto-solo-para-probar-en-local-0123456789";
const PUERTO = Number(process.env.PORT ?? 3000);
const OFERTAS = [
  { ofertaId: "11111111-1111-4111-8111-111111111111", conductorId: "cond-1" },
  { ofertaId: "22222222-2222-4222-8222-222222222222", conductorId: "cond-2" },
  { ofertaId: "33333333-3333-4333-8333-333333333333", conductorId: "cond-3" },
];

const config = leerConfig({
  JWT_SECRETO: SECRETO,
  JWT_CLAIM_CONDUCTOR: "conductor_id",
  PORT: String(PUERTO),
  RATE_LIMIT_MAX: "1000",
});
const logger = crearLogger({ nivel: process.env.LOG_LEVEL ?? "info" });

// ── Datos temporales: una solicitud BUSCANDO con tres ofertas de tres conductores ──
const mundo = escenarioConOfertas(0);
mundo.deps.reloj = () => new Date(); // reloj real
function sembrar() {
  const venceEn = new Date(Date.now() + 30 * 60 * 1000);
  mundo.estado.solicitudes.clear();
  mundo.estado.ofertas.clear();
  mundo.estado.busquedas.clear();
  mundo.estado.eventos.length = 0;
  for (const k of ["cacheEliminado", "conductorAsignado", "liberados"]) mundo.espias[k].length = 0;
  mundo.estado.solicitudes.set("sol-1", { solicitudId: "sol-1", estado: "BUSCANDO", conductorAsignadoId: null });
  mundo.estado.busquedas.set("sol-1", {
    busquedaId: "bus-1", solicitudId: "sol-1", estado: "ACTIVA", venceEn, candidatosRestantes: 3,
  });
  for (const o of OFERTAS) {
    mundo.estado.ofertas.set(o.ofertaId, { ...o, solicitudId: "sol-1", estado: "PENDIENTE", venceEn });
  }
}
sembrar();

// ── Tokens de prueba (en producción los emite M1) ──
const firmar = (claims) =>
  jwt.sign({ sub: `identidad-${claims.conductor_id ?? "x"}`, ...claims }, SECRETO, { algorithm: "HS256", expiresIn: "8h" });
const tokens = {
  COND1: firmar({ roles: ["CONDUCTOR"], conductor_id: "cond-1" }),
  COND2: firmar({ roles: ["CONDUCTOR"], conductor_id: "cond-2" }),
  COND3: firmar({ roles: ["CONDUCTOR"], conductor_id: "cond-3" }),
  CLIENTE: firmar({ roles: ["CLIENTE"] }),
  ADMIN: firmar({ roles: ["ADMINISTRADOR"] }),
};

// ── Rutas: la real (respuesta de un conductor) + auxiliares SOLO para probar ──
function registrarRutas(app, { requerirRol, validar }) {
  app.use(crearRouterRespuesta({ deps: mundo.deps, requerirRol, validar }));

  app.get("/debug/estado", requerirRol(ROLES.ADMINISTRADOR), (req, res) => {
    res.json({
      solicitudes: [...mundo.estado.solicitudes.values()],
      ofertas: [...mundo.estado.ofertas.values()].map(({ ofertaId, conductorId, estado }) => ({ ofertaId, conductorId, estado })),
      busquedas: [...mundo.estado.busquedas.values()],
      eventos: mundo.estado.eventos,
      avisos: {
        conductorAsignado: mundo.espias.conductorAsignado,
        liberados: mundo.espias.liberados,
        cacheEliminado: mundo.espias.cacheEliminado,
      },
    });
  });

  // Hace lo que haría A al cancelar y después llama a la reacción de B (la mía).
  app.post("/debug/cancelar", requerirRol(ROLES.ADMINISTRADOR), async (req, res, next) => {
    try {
      const cancelada = await mundo.cancelarSolicitud("sol-1");
      if (!cancelada) return res.status(409).json({ cancelada: false, motivo: "ya no estaba BUSCANDO" });
      const r = await procesarCancelacionSolicitud({ solicitudId: "sol-1" }, mundo.deps);
      return res.json({ cancelada: true, ...r });
    } catch (e) { return next(e); }
  });

  app.post("/debug/reiniciar", requerirRol(ROLES.ADMINISTRADOR), (req, res) => {
    sembrar();
    res.json({ reiniciado: true });
  });
}

const app = crearApp({ config, logger, verificador: crearVerificadorLocal(config), registrarRutas });
const servidor = app.listen(PUERTO, "127.0.0.1", () => {
  console.log(`\nServidor de prueba en http://127.0.0.1:${PUERTO}  (datos en memoria)\n`);
  console.log("Ofertas: " + OFERTAS.map((o) => `${o.conductorId}=${o.ofertaId}`).join("  "));
  for (const [nombre, t] of Object.entries(tokens)) console.log(`TOKEN_${nombre}=${t}`);
  console.log("");
});
process.on("SIGINT", () => servidor.close(() => process.exit(0)));
