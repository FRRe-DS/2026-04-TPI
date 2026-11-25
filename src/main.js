// Backend de M5. El servidor del frontend valida Keycloak y se comunica con
// esta API usando INTERNAL_API_TOKEN. Esta API persiste las solicitudes,
// inicia el despacho y recibe respuestas de M3.
const dotenv = require("dotenv");
dotenv.config();
dotenv.config({ path: "bd/.env", override: false });
dotenv.config({ path: "front/.env", override: false });

const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { PrismaClient } = require("@prisma/client");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");

const { crearLogger } = require("./comun/logger");
const { crearClienteHttp } = require("./comun/clienteHttp");
const { crearRepositorioCandidatos } = require("./busqueda/repositorioCandidatos");
const { crearRepositorioOfertas, crearEjecutarEnTransaccion } = require("./respuesta/repositorioOfertas");
const { crearBuscadorCandidatos } = require("./busqueda/busquedaService");
const { crearNotificaciones } = require("./asignacion/notificaciones");
const { iniciarDespacho } = require("./ofertas/despacho");
const { iniciarJobTandas } = require("./ofertas/jobTandas");
const { iniciarJobVencimientos } = require("./respuesta/jobVencimientos");
const { procesarCancelacionSolicitud } = require("./asignacion/procesarCancelacion");
const { crearRouterRespuesta } = require("./respuesta/rutas");
const { construirIdentidad, autenticar, requerirRol, requerirScope } = require("./comun/autenticacion");

const PUERTO = Number(process.env.PORT) || 3001;
const TOKEN_INTERNO = process.env.INTERNAL_API_TOKEN || "";
const LIMITE_CUERPO = process.env.BODY_LIMITE || "1mb";
const logger = crearLogger({ nivel: process.env.LOG_LEVEL || "info" });

// Convierte el registro de Prisma al formato que consumen el frontend y los otros módulos.
function mapSolicitud(row) {
  return {
    solicitudId: row.idSolicitud,
    clienteId: row.idCliente,
    origen: { lat: row.origenLat, lng: row.origenLng },
    destino: { lat: row.destinoLat, lng: row.destinoLng },
    tipoVehiculo: row.tipoVehiculo,
    vehiculo_id: row.vehiculo_id ?? null,
    costo: row.costo ?? null,
    moneda: row.moneda ?? null,
    tipoActivacion: row.tipoActivacion,
    reservaId: row.reservaId,
    conductorId: row.conductorId,
    estado: row.estado,
    creadaEn: row.creadaEn,
  };
}

// Comprueba que un punto del mapa tenga latitud y longitud dentro de sus rangos válidos.
function validarPunto(punto, nombre) {
  const lat = Number(punto?.lat);
  const lng = Number(punto?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw Object.assign(new Error(`${nombre}.lat debe estar entre -90 y 90.`), { status: 400 });
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw Object.assign(new Error(`${nombre}.lng debe estar entre -180 y 180.`), { status: 400 });
  return { lat, lng };
}

// Construye los adaptadores que conectan las operaciones de despacho con Prisma.
// Los métodos condicionales de solicitud son los que evitan asignar dos conductores a la vez.
function crearPersistencia(prisma) {
  const ofertas = crearRepositorioOfertas(prisma);
  const candidatos = crearRepositorioCandidatos(prisma);

  // Adaptador de solicitudes: consulta datos, asigna un ganador y cierra búsquedas agotadas.
  const solicitudes = {
    // Lee el estado actual y el conductor ganador, si ya existe.
    obtenerEstado: async (solicitudId, tx) => {
      const fila = await (tx ?? prisma).solicitud.findUnique({
        where: { idSolicitud: solicitudId },
        select: { estado: true, conductorId: true },
      });
      return fila ? { estado: fila.estado.toLowerCase(), conductorAsignadoId: fila.conductorId } : null;
    },
    // Recupera el trayecto y el vehículo para iniciar el envío de ofertas.
    obtenerDatosViaje: async (solicitudId, tx) => {
      const fila = await (tx ?? prisma).solicitud.findUnique({ where: { idSolicitud: solicitudId } });
      if (!fila) return null;
      return {
        clienteId: fila.idCliente,
        reservaId: fila.reservaId,
        origen: { latitud: fila.origenLat, longitud: fila.origenLng },
        destino: { latitud: fila.destinoLat, longitud: fila.destinoLng },
        tipoVehiculo: fila.tipoVehiculo,
      };
    },
    // Asigna al conductor solo si la solicitud continúa en estado "buscando".
    asignar: async ({ solicitudId, conductorId }, tx) => {
      const db = tx ?? prisma;
      const actualizado = await db.solicitud.updateMany({
        where: { idSolicitud: solicitudId, estado: "buscando" },
        data: { estado: "asignada", conductorId },
      });
      if (actualizado.count === 1) return { resultado: "asignada" };
      const actual = await db.solicitud.findUnique({ where: { idSolicitud: solicitudId }, select: { estado: true } });
      if (!actual) return { resultado: "solicitud_inexistente" };
      if (actual.estado.toLowerCase() === "cancelada") return { resultado: "solicitud_cancelada" };
      if (actual.estado.toLowerCase() === "asignada") return { resultado: "ya_asignada" };
      return { resultado: "solicitud_no_buscando" };
    },
    // Marca "sin_disponibilidad" solo si la solicitud todavía está buscando.
    marcarSinDisponibilidad: async ({ solicitudId }, tx) => {
      const db = tx ?? prisma;
      const actualizado = await db.solicitud.updateMany({
        where: { idSolicitud: solicitudId, estado: "buscando" },
        data: { estado: "sin_disponibilidad" },
      });
      const actual = await db.solicitud.findUnique({ where: { idSolicitud: solicitudId }, select: { estado: true } });
      return { aplicado: actualizado.count === 1, estadoActual: actual?.estado.toLowerCase() ?? null };
    },
    // Pasa una solicitud pendiente al estado que habilita el despacho.
    iniciarBusqueda: async (solicitudId) => prisma.solicitud.updateMany({
      where: { idSolicitud: solicitudId, estado: "pendiente" },
      data: { estado: "buscando" },
    }),
    // Lista solicitudes que esperan un intento o reintento de despacho.
    listarPendientesDespacho: (lote = 50) => prisma.solicitud.findMany({
      where: { estado: "buscando" },
      orderBy: { creadaEn: "asc" },
      take: lote,
      select: { idSolicitud: true, origenLat: true, origenLng: true, destinoLat: true, destinoLng: true, tipoVehiculo: true },
    }),
    // Completa el vehículo asociado al conductor ganador sin alterar la asignación ya confirmada.
    actualizarVehiculoAsignado: async ({ solicitudId, conductorId, vehiculoId }) => {
      const resultado = await prisma.solicitud.updateMany({
        where: { idSolicitud: solicitudId, conductorId, estado: "asignada" },
        data: { vehiculo_id: vehiculoId },
      });
      return { count: resultado.count };
    },
  };

  // Adaptador de búsquedas: crea rondas, reclama tandas y actualiza su estado en la base.
  const busquedas = {
    // Busca la ronda activa de una solicitud.
    obtenerActiva: (solicitudId, tx) => (tx ?? prisma).busqueda.findFirst({
      where: { solicitudId, estado: "activa" },
      select: { busquedaId: true, venceEn: true, candidatosRestantes: true, proximaTandaEn: true },
    }),
    // Registra una nueva ronda con su vencimiento y la hora de la próxima tanda.
    crear: ({ solicitudId, venceEn, candidatosRestantes, proximaTandaEn }, tx) => (tx ?? prisma).busqueda.create({
      data: { solicitudId, venceEn, candidatosRestantes, proximaTandaEn },
    }),
    // Reclama la tanda con una actualización condicional para evitar envíos duplicados.
    reclamarTanda: async ({ solicitudId, ahora, proximaTandaEn }, tx) => {
      const r = await (tx ?? prisma).busqueda.updateMany({
        where: { solicitudId, estado: "activa", proximaTandaEn: { lte: ahora } },
        data: { proximaTandaEn },
      });
      return r.count === 1;
    },
    // Actualiza cuántos candidatos quedan pendientes de recibir oferta.
    registrarTanda: async ({ solicitudId, candidatosRestantes }, tx) => {
      const r = await (tx ?? prisma).busqueda.updateMany({
        where: { solicitudId, estado: "activa" },
        data: { candidatosRestantes },
      });
      return { actualizadas: r.count };
    },
    // Cierra una búsqueda activa al asignarse, agotarse o cancelarse.
    cerrar: async ({ solicitudId, estado }, tx) => {
      const r = await (tx ?? prisma).busqueda.updateMany({
        where: { solicitudId, estado: "activa" },
        data: { estado },
      });
      return r.count === 1;
    },
    // Hace que la siguiente tanda pueda enviarse sin esperar el intervalo previsto.
    adelantarTanda: async ({ solicitudId, ahora }, tx) => {
      const r = await (tx ?? prisma).busqueda.updateMany({
        where: { solicitudId, estado: "activa" },
        data: { proximaTandaEn: ahora },
      });
      return r.count === 1;
    },
    // Encuentra las búsquedas cuya siguiente tanda ya debe procesarse.
    listarTandasVencidas: ({ ahora, lote = 50 }) => prisma.busqueda.findMany({
      where: { estado: "activa", proximaTandaEn: { lte: ahora } },
      orderBy: { proximaTandaEn: "asc" }, take: lote,
      select: { solicitudId: true },
    }),
  };

  // Guarda los eventos del despacho para mantener un historial auditable.
  const eventos = {
    // Inserta el evento dentro de la transacción recibida o usa Prisma directamente.
    registrar: ({ solicitudId, tipo, conductorId, ofertaId, ocurridoEn, detalle }, tx) => (tx ?? prisma).evento.create({
      data: { solicitudId, tipo, conductorId, ofertaId, ocurridoEn, detalle },
    }),
  };

  return { solicitudes, ofertas, busquedas, candidatos, eventos, ejecutarEnTransaccion: crearEjecutarEnTransaccion(prisma) };
}

// Prepara clientes HTTP, rutas y dependencias que usa el flujo de despacho.
// M2 valida clientes; M3, M4 y M6 participan del despacho; M7 calcula tarifas cuando se solicita.
function crearDependencias(prisma) {
  const m2 = process.env.M2_URL
    ? crearClienteHttp({ baseUrl: process.env.M2_URL, tokenPorDefecto: process.env.M2_TOKEN, timeoutMs: 3000, reintentos: 2, logger })
    : null;
  if (!m2) throw new Error("M2_URL debe configurarse para validar el estado de la cuenta antes del alta");
  const m3 = crearClienteHttp({ baseUrl: process.env.M3_URL, tokenPorDefecto: process.env.M3_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m4 = crearClienteHttp({ baseUrl: process.env.M4_URL, tokenPorDefecto: process.env.M4_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m6 = crearClienteHttp({ baseUrl: process.env.M6_URL, tokenPorDefecto: process.env.M6_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m7 = process.env.M7_URL
    ? crearClienteHttp({ baseUrl: process.env.M7_URL, tokenPorDefecto: process.env.M7_TOKEN, timeoutMs: 3000, reintentos: 2, logger })
    : null;
  const rutas = {
    m3EnviarOfertas: () => process.env.M3_RUTA_ENVIAR_OFERTAS || "/api/v1/integration/m5/offers",
    m6ConductorAsignado: () => process.env.M6_RUTA_CREAR_VIAJE || "/trips",
    m4ReservarConductor: ({ conductorId }) => `/api/v1/conductores/${encodeURIComponent(conductorId)}/reserva`,
    m4LiberarConductor: ({ conductorId }) => `/api/v1/conductores/${encodeURIComponent(conductorId)}/reserva`,
  };
  const persistencia = crearPersistencia(prisma);
  const notificaciones = crearNotificaciones({
    clienteM3: m3,
    clienteM4: m4,
    clienteM6: m6,
    rutas,
    logger,
    obtenerVehiculoConductor: async (conductorId) => {
      const respuesta = await m3.post(
        process.env.M3_RUTA_CONDUCTOR_DETALLE || "/api/v1/integration/drivers/dispatch-info",
        { conductor_id: conductorId }
      );
      if ((respuesta?.conductor_id ?? conductorId) !== conductorId || !respuesta?.vehiculo?.vehiculo_id) return null;
      return {
        vehiculoId: String(respuesta.vehiculo.vehiculo_id),
        tipoVehiculo: respuesta.vehiculo.tipo_vehiculo,
      };
    },
    solicitudes: persistencia.solicitudes,
  });
  const buscador = crearBuscadorCandidatos({
    clienteM4: {
      consultarM4: (pedido) => {
        const query = new URLSearchParams({
          origen_latitud: String(pedido.origen_latitud),
          origen_longitud: String(pedido.origen_longitud),
          tipo_vehiculo: String(pedido.tipo_vehiculo),
        });
        return m4.get(`${process.env.M4_RUTA_BUSCAR || "/api/v1/conductores/cercanos"}?${query}`);
      },
    },
    candidatos: persistencia.candidatos,
    logger,
  });
  const deps = {
    ...persistencia,
    notificaciones,
    buscador,
    cacheOfertas: { eliminar: async () => {} },
    logger,
    timeoutAvisosMs: 3000,
    despacho: {
      tamanoTanda: Number(process.env.TAMANO_TANDA) || 3,
      esperaTandaMs: Number(process.env.ESPERA_TANDA_MS) || 20_000,
      vigenciaOfertaMs: Number(process.env.VIGENCIA_OFERTA_MS) || 30_000,
      plazoBusquedaMs: Number(process.env.PLAZO_BUSQUEDA_MS) || 180_000,
    },
  };
  const estimarTarifa = async ({ origen, destino, tipoVehiculo }) => {
    if (!m7) throw Object.assign(new Error("M7_URL no está configurada."), { status: 503 });
    if (!["AUTO", "MOTO"].includes(tipoVehiculo)) {
      throw Object.assign(new Error("tipoVehiculo debe ser AUTO o MOTO."), { status: 400 });
    }
    const origenValidado = validarPunto(origen, "origen");
    const destinoValidado = validarPunto(destino, "destino");
    const query = new URLSearchParams({
      origen_latitud: String(origenValidado.lat), origen_longitud: String(origenValidado.lng),
      destino_latitud: String(destinoValidado.lat), destino_longitud: String(destinoValidado.lng),
    });
    const rutaBaseM4 = process.env.M4_RUTA_ESTIMACION || "/api/v1/rutas/estimacion";
    const separador = rutaBaseM4.includes("?") ? "&" : "?";
    query.set("tipo_vehiculo", tipoVehiculo);
    const rutaM4 = `${rutaBaseM4}${separador}${query}`;
    const trayecto = await m4.get(rutaM4);
    const distancia = Number(trayecto.distancia_estimada_km);
    const eta = Number(trayecto.eta_minutos);
    if (!Number.isFinite(distancia) || !Number.isFinite(eta)) {
      throw Object.assign(new Error("M4 devolvió una estimación incompleta."), { status: 502 });
    }
    return m7.post(process.env.M7_RUTA_ESTIMACION || "/api/v1/tarifas/estimaciones", {
      tipo_vehiculo: tipoVehiculo === "MOTO" ? "moto" : "auto",
      distancia_km: distancia,
      duracion_estimada_min: Math.ceil(eta),
    });
  };
  // Consulta a M2 y solo permite crear solicitudes si la cuenta está activa.
  const validarCliente = async (clienteId) => {
    if (!m2) throw Object.assign(new Error("M2_URL no está configurada."), { status: 503 });
    let perfil;
    try {
      perfil = await m2.get(`/api/v1/clientes/${encodeURIComponent(clienteId)}/estado-cuenta`);
    } catch (error) {
      if (error.estado === 404) throw Object.assign(new Error("El cliente no tiene un perfil registrado en M2."), { status: 422 });
      throw error;
    }
    if (perfil?.estado !== "ACTIVO") {
      throw Object.assign(new Error("La cuenta del cliente no está habilitada para crear solicitudes."), { status: 422 });
    }
  };
  return { deps, estimarTarifa, validarCliente };
}

// Crea la aplicación HTTP, configura seguridad y registra las rutas usadas por el frontend y M3.
function crearApp({ prisma, deps, verificador, estimarTarifa, validarCliente }) {
  if (!TOKEN_INTERNO || TOKEN_INTERNO.length < 32) {
    throw new Error("INTERNAL_API_TOKEN debe tener al menos 32 caracteres");
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));
  app.use(express.json({ limit: LIMITE_CUERPO }));
  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || crypto.randomUUID();
    res.setHeader("x-request-id", req.id);
    req.log = logger.child({ reqId: req.id });
    res.on("finish", () => req.log.info({ method: req.method, path: req.path, status: res.statusCode }, "request"));
    next();
  });
  const despachosEnCurso = new Set();
  app.locals.despacharSolicitud = (solicitud, requestLogger = logger) => {
    if (despachosEnCurso.has(solicitud.solicitudId)) return Promise.resolve({ resultado: "ya_en_curso" });
    despachosEnCurso.add(solicitud.solicitudId);
    return iniciarDespacho({ solicitud }, deps)
      .catch((error) => requestLogger.error({ err: error, solicitudId: solicitud.solicitudId }, "no se pudo iniciar el despacho; se reintentará"))
      .finally(() => despachosEnCurso.delete(solicitud.solicitudId));
  };

  // Las rutas llamadas por el BFF del frontend requieren un secreto compartido entre ambos servidores.
  const interno = (req, res, next) => {
    const recibido = req.get("x-m5-internal-token") || "";
    const a = Buffer.from(recibido);
    const b = Buffer.from(TOKEN_INTERNO);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Autenticación interna requerida." });
    }
    next();
  };

  // Liveness: confirma que el proceso está respondiendo.
  app.get("/health", (_req, res) => res.status(200).json({ estado: "ok" }));
  // Readiness: verifica que el backend también pueda consultar MySQL.
  app.get("/health/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ estado: "ok", componentes: { mysql: "ok" } });
    } catch {
      res.status(503).json({ estado: "degradado", componentes: { mysql: "falla" } });
    }
  });

  app.use("/solicitudes", (req, res, next) => {
    if (req.path === "/desde-reserva") return next();
    return interno(req, res, next);
  });

  // RF-5.1: obtiene distancia y duración de M4 y pide a M7 el cálculo de tarifa.
  app.post("/solicitudes/estimacion", async (req, res, next) => {
    try {
      if (typeof estimarTarifa !== "function") return res.status(503).json({ error: "La integración con M7 no está configurada." });
      const { origen, destino, tipoVehiculo } = req.body || {};
      if (!origen || !destino) return res.status(400).json({ error: "Seleccioná origen y destino para calcular el costo." });
      const resultado = await estimarTarifa({ origen, destino, tipoVehiculo });
      res.json(resultado);
    } catch (error) { next(error); }
  });

  // Crea un viaje inmediato desde el frontend y arranca el despacho sin demorar la respuesta HTTP.
  app.post("/solicitudes", async (req, res, next) => {
    try {
      const { idCliente, origen, destino, tipoVehiculo, tipoActivacion = "Inmediata", reservaId = null } = req.body || {};
      if (!idCliente || !origen || !destino || !["AUTO", "MOTO"].includes(tipoVehiculo)) {
        return res.status(400).json({ error: "Se requieren idCliente, origen, destino y tipoVehiculo (AUTO o MOTO)." });
      }
      if (!["Inmediata", "Reserva"].includes(tipoActivacion) || (tipoActivacion === "Reserva" && !reservaId)) {
        return res.status(400).json({ error: "tipoActivacion debe ser Inmediata o Reserva; Reserva requiere reservaId." });
      }
      await validarCliente(String(idCliente));
      const origenValidado = validarPunto(origen, "origen");
      const destinoValidado = validarPunto(destino, "destino");
      const tarifa = await estimarTarifa({ origen: origenValidado, destino: destinoValidado, tipoVehiculo });
      const costo = Number(tarifa?.desglose?.total);
      if (!Number.isFinite(costo) || costo < 0) throw Object.assign(new Error("M7 no devolvió un costo estimado válido."), { status: 502 });
      const solicitud = await prisma.solicitud.create({ data: {
        idCliente: String(idCliente),
        origenLat: origenValidado.lat, origenLng: origenValidado.lng,
        destinoLat: destinoValidado.lat, destinoLng: destinoValidado.lng,
        tipoVehiculo, vehiculo_id: null, costo, moneda: tarifa.moneda || "ARS", tipoActivacion,
        reservaId: reservaId ? String(reservaId) : null,
        estado: "buscando",
      } });
      const vista = mapSolicitud(solicitud);
      app.locals.despacharSolicitud({
        solicitudId: solicitud.idSolicitud,
        origen: { latitud: solicitud.origenLat, longitud: solicitud.origenLng },
        destino: { latitud: solicitud.destinoLat, longitud: solicitud.destinoLng },
        tipoVehiculo,
      }, req.log);
      return res.status(201).json(vista);
    } catch (error) {
      if (error.code === "P2002") return res.status(409).json({ error: "Ya existe una solicitud para ese reservaId." });
      return next(error);
    }
  });

  // RF-5.2: recibe de M9 una reserva activada. Solo acepta tokens de servicio autorizados.
  app.post("/solicitudes/desde-reserva", autenticar(verificador), requerirRol("SERVICIO"), async (req, res, next) => {
    try {
      const body = req.body || {};
      const idCliente = String(body.cliente_id || "").trim();
      const tipoVehiculo = String(body.tipo_vehiculo || "").toUpperCase();
      const origen = { lat: Number(body.origen_latitud), lng: Number(body.origen_longitud) };
      const destino = { lat: Number(body.destino_latitud), lng: Number(body.destino_longitud) };
      const reservaId = String(body.reserva_id || "").trim();
      if (!idCliente || !reservaId || !["AUTO", "MOTO"].includes(tipoVehiculo) ||
          ![origen.lat, origen.lng, destino.lat, destino.lng].every(Number.isFinite)) {
        return res.status(400).json({ error: "El cuerpo de activación de reserva está incompleto o es inválido." });
      }
      await validarCliente(idCliente);
      const tarifa = await estimarTarifa({ origen, destino, tipoVehiculo });
      const costo = Number(tarifa?.desglose?.total);
      if (!Number.isFinite(costo) || costo < 0) throw Object.assign(new Error("M7 no devolvió un costo estimado válido."), { status: 502 });
      const solicitud = await prisma.solicitud.create({ data: {
        idCliente, origenLat: origen.lat, origenLng: origen.lng,
        destinoLat: destino.lat, destinoLng: destino.lng,
        tipoVehiculo, vehiculo_id: null, costo, moneda: tarifa.moneda || "ARS",
        tipoActivacion: "Reserva", reservaId, estado: "buscando",
      } });
      app.locals.despacharSolicitud({
        solicitudId: solicitud.idSolicitud,
        origen: { latitud: solicitud.origenLat, longitud: solicitud.origenLng },
        destino: { latitud: solicitud.destinoLat, longitud: solicitud.destinoLng },
        tipoVehiculo,
      }, req.log);
      return res.status(201).json({ solicitud_id: solicitud.idSolicitud, estado: solicitud.estado });
    } catch (error) {
      if (error.code === "P2002") {
        const existente = await prisma.solicitud.findUnique({ where: { reservaId: String(req.body?.reserva_id || "") } });
        if (existente) return res.status(200).json({ solicitud_id: existente.idSolicitud, estado: existente.estado });
      }
      return next(error);
    }
  });

  // Devuelve las solicitudes para el panel de administración del frontend.
  app.get("/solicitudes", async (_req, res, next) => {
    try {
      const rows = await prisma.solicitud.findMany({ orderBy: { creadaEn: "desc" } });
      res.json(rows.map(mapSolicitud));
    } catch (error) { next(error); }
  });

  // Devuelve el estado actual para que el frontend pueda reflejar los cambios del despacho.
  app.get("/solicitudes/:id", async (req, res, next) => {
    try {
      const row = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!row) return res.status(404).json({ error: "Solicitud no encontrada." });
      return res.json(mapSolicitud(row));
    } catch (error) { next(error); }
  });

  // Cancela una solicitud que todavía no fue asignada y ejecuta la limpieza de ofertas y reservas.
  app.patch("/solicitudes/:id/cancelar", async (req, res, next) => {
    try {
      const cambio = await prisma.solicitud.updateMany({
        where: { idSolicitud: req.params.id, estado: { in: ["pendiente", "PENDIENTE_ASIGNACION", "buscando"] } },
        data: { estado: "cancelada" },
      });
      const solicitud = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (cambio.count) {
        await procesarCancelacionSolicitud({ solicitudId: req.params.id }, deps);
      } else if (solicitud.estado.toLowerCase() !== "cancelada") {
        return res.status(409).json({ error: "La solicitud ya no puede cancelarse." });
      }
      return res.json(mapSolicitud(solicitud));
    } catch (error) { next(error); }
  });

  // Elimina una solicitud desde la función administrativa del frontend.
  app.delete("/solicitudes/:id", async (req, res, next) => {
    try {
      await prisma.solicitud.delete({ where: { idSolicitud: req.params.id } });
      res.json({ eliminado: true, solicitudId: req.params.id });
    } catch (error) {
      if (error.code === "P2025") return res.status(404).json({ error: "Solicitud no encontrada." });
      next(error);
    }
  });

  if (verificador) {
    // Recibe de M3 la aceptación o el rechazo de una oferta, validando el JWT y el rol del conductor.
    const router = crearRouterRespuesta({
      deps,
      requerirRol,
      requerirScope,
      validar: require("./comun/validacion").validar,
    });
    app.use("/api/v1", autenticar(verificador), router);
  }

  // Traduce errores internos a respuestas HTTP sin filtrar trazas ni detalles sensibles.
  app.use((err, req, res, _next) => {
    req.log?.error({ err }, "error de backend");
    const status = err.status || (err.estado ? 503 : 500);
    const mensaje = status < 500 ? err.message : "Error interno del servidor.";
    res.status(status).json({ error: mensaje, codigo: err.codigo || "ERROR_INTERNO" });
  });
  return app;
}

// Crea la conexión Prisma a MySQL usando los parámetros del entorno.
function crearPrisma() {
  const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "despacho",
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 5,
  });
  return new PrismaClient({ adapter });
}

// Arranca la API, conecta la base, registra trabajos periódicos y prepara el cierre ordenado.
async function iniciarServidor() {
  const prisma = crearPrisma();
  const verificador = await crearVerificadorKeycloak();
  const { deps, estimarTarifa, validarCliente } = crearDependencias(prisma);
  const app = crearApp({ prisma, deps, verificador, estimarTarifa, validarCliente });
  await prisma.$connect();
  const server = app.listen(PUERTO, () => logger.info({ puerto: PUERTO }, "API backend M5 iniciada"));
  const trabajos = [
    iniciarJobTandas({ deps, logger }),
    iniciarJobVencimientos({ deps, logger }),
  ];

  // Reintenta despachos que quedaron en estado BUSCANDO si M4 no estuvo disponible al crearlos.
  const recuperarDespachos = setInterval(async () => {
    try {
      const pendientes = await deps.solicitudes.listarPendientesDespacho();
      for (const fila of pendientes) {
        if (await deps.busquedas.obtenerActiva(fila.idSolicitud)) continue;
        try {
          await app.locals.despacharSolicitud({
            solicitudId: fila.idSolicitud,
            origen: { latitud: fila.origenLat, longitud: fila.origenLng },
            destino: { latitud: fila.destinoLat, longitud: fila.destinoLng },
            tipoVehiculo: fila.tipoVehiculo,
          }, logger);
        } catch (error) {
          logger.warn({ err: error, solicitudId: fila.idSolicitud }, "se reintentará iniciar el despacho");
        }
      }
    } catch (error) { logger.error({ err: error }, "falló la recuperación de despachos"); }
  }, Number(process.env.REINTENTO_DESPACHO_MS) || 5000);
  recuperarDespachos.unref?.();

  const cerrar = async () => {
    clearInterval(recuperarDespachos);
    trabajos.forEach((trabajo) => trabajo.detener());
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  };
  process.once("SIGINT", cerrar);
  process.once("SIGTERM", cerrar);
  return { app, server, prisma, deps, cerrar };
}

// Verifica los JWT de Keycloak con sus claves públicas remotas y extrae identidad, roles y conductor.
async function crearVerificadorKeycloak() {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const keycloakUrl = (process.env.KEYCLOAK_URL || "").replace(/\/$/, "");
  const realm = process.env.KEYCLOAK_REALM || "";
  if (!keycloakUrl || !realm) throw new Error("KEYCLOAK_URL y KEYCLOAK_REALM son obligatorios para validar respuestas de M3");
  const issuer = `${keycloakUrl}/realms/${encodeURIComponent(realm)}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  const configClaims = {
    claimIdentidad: process.env.JWT_CLAIM_IDENTIDAD || "sub",
    claimRoles: process.env.JWT_CLAIM_ROLES || "realm_access.roles",
    claimScopes: process.env.JWT_CLAIM_SCOPES || "scope",
    claimConductor: process.env.JWT_CLAIM_CONDUCTOR || "conductor_id",
  };
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ["RS256"] });
      return construirIdentidad(payload, configClaims);
    } catch {
      throw Object.assign(new Error("Credenciales ausentes o inválidas."), { status: 401, codigo: "NO_AUTENTICADO" });
    }
  };
}

if (require.main === module) {
  iniciarServidor().catch((error) => {
    logger.fatal({ err: error }, "no se pudo iniciar el backend M5");
    process.exitCode = 1;
  });
}

module.exports = { crearApp, crearDependencias, crearPersistencia, iniciarServidor, mapSolicitud, crearVerificadorKeycloak };
