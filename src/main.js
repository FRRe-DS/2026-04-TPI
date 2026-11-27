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
const { obtenerTokenM2 } = require("./comun/tokenM2");
const { crearRepositorioCandidatos } = require("./busqueda/repositorioCandidatos");
const { crearRepositorioOfertas, crearEjecutarEnTransaccion } = require("./respuesta/repositorioOfertas");
const { crearBuscadorCandidatos } = require("./busqueda/busquedaService");
const { crearNotificaciones } = require("./asignacion/notificaciones");
const { iniciarDespacho } = require("./ofertas/despacho");
const { iniciarJobTandas } = require("./ofertas/jobTandas");
const { iniciarJobVencimientos } = require("./respuesta/jobVencimientos");
const { procesarCancelacionSolicitud } = require("./asignacion/procesarCancelacion");
const { procesarCancelacionM6 } = require("./integraciones/m6Cancelaciones");
const { iniciarConsumidorM6 } = require("./integraciones/m6Consumer");
const { crearOutboxM8 } = require("./integraciones/m8Outbox");
const { crearRouterRespuesta } = require("./respuesta/rutas");
const { construirIdentidad, autenticar, requerirRol, requerirScope } = require("./comun/autenticacion");
const { obtenerTokenServicio } = require("./comun/tokenServicio");
const { TipoEvento } = require("./comun/estados");

const PUERTO = Number(process.env.PORT) || 3001;
const TOKEN_INTERNO = process.env.INTERNAL_API_TOKEN || "";
const LIMITE_CUERPO = process.env.BODY_LIMITE || "1mb";
const logger = crearLogger({ nivel: process.env.LOG_LEVEL || "info" });

// Convierte el registro de Prisma al formato que consumen el frontend y los otros módulos.
function mapSolicitud(row) {
  const creadaEn = row.creadaEn instanceof Date ? row.creadaEn.toISOString() : row.creadaEn;
  return {
    // Formato interno consumido por el BFF actual.
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
    creadaEn,
    // Campos snake_case definidos por docs/openapi-a.yml.
    solicitud_id: row.idSolicitud,
    cliente_id: row.idCliente,
    origen_latitud: row.origenLat,
    origen_longitud: row.origenLng,
    destino_latitud: row.destinoLat,
    destino_longitud: row.destinoLng,
    tipo_vehiculo: row.tipoVehiculo,
    conductor_id: row.conductorId ?? undefined,
    reserva_id: row.reservaId ?? undefined,
    tarifa_estimada: row.costo == null ? undefined : { moneda: row.moneda || "ARS", total_estimado: row.costo },
    creada_en: creadaEn,
  };
}

function mapOfertaContrato(row) {
  const creada = row.enviadaEn ?? row.creadaEn;
  return {
    oferta_id: row.ofertaId,
    solicitud_id: row.solicitudId,
    conductor_id: row.conductorId,
    estado: String(row.estado).toLowerCase(),
    creada_en: creada instanceof Date ? creada.toISOString() : creada,
    vence_en: row.venceEn instanceof Date ? row.venceEn.toISOString() : row.venceEn,
    ...(row.respondidaEn ? { respondida_en: row.respondidaEn instanceof Date ? row.respondidaEn.toISOString() : row.respondidaEn } : {}),
  };
}

function mapEventoContrato(row) {
  const tipos = {
    SOLICITUD_CREADA: "SOLICITUD_CREADA",
    BUSQUEDA: row.detalle?.startsWith("Búsqueda iniciada") ? "BUSQUEDA_INICIADA" : "BUSQUEDA_AGOTADA",
    OFERTA: row.detalle?.startsWith("No se pudo") ? "ERROR_INTEGRACION" : "OFERTA_EMITIDA",
    RECHAZO: "OFERTA_RECHAZADA",
    VENCIMIENTO: "OFERTA_VENCIDA",
    ACEPTACION: "OFERTA_ACEPTADA",
    CANCELACION: row.ofertaId ? "OFERTA_CANCELADA" : "SOLICITUD_CANCELADA",
  };
  return {
    id: row.eventoId,
    solicitud_id: row.solicitudId,
    ...(row.ofertaId ? { oferta_id: row.ofertaId } : {}),
    tipo: tipos[row.tipo] || "ERROR_INTEGRACION",
    fecha: row.ocurridoEn instanceof Date ? row.ocurridoEn.toISOString() : row.ocurridoEn,
    ...(row.detalle ? { detalle: row.detalle } : {}),
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

function emailValido(valor) {
  return typeof valor === "string" && valor.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
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
        clienteEmail: fila.emailCliente,
        reservaId: fila.reservaId,
        requestIdM6: fila.requestIdM6 || fila.idSolicitud,
        viajeId: fila.viajeId,
        costo: fila.costo,
        moneda: fila.moneda,
        creadaEn: fila.creadaEn,
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
      select: {
        idSolicitud: true, origenLat: true, origenLng: true, destinoLat: true, destinoLng: true,
        tipoVehiculo: true, intentoDespacho: true,
      },
    }),
    // Completa el vehículo asociado al conductor ganador sin alterar la asignación ya confirmada.
    actualizarVehiculoAsignado: async ({ solicitudId, conductorId, vehiculoId }) => {
      const resultado = await prisma.solicitud.updateMany({
        where: { idSolicitud: solicitudId, conductorId, estado: "asignada" },
        data: { vehiculo_id: vehiculoId },
      });
      return { count: resultado.count };
    },
    actualizarViajeM6: async ({ solicitudId, requestIdM6, viajeId }) => {
      const resultado = await prisma.solicitud.updateMany({
        where: { idSolicitud: solicitudId, requestIdM6, estado: "asignada" },
        data: { viajeId },
      });
      return { count: resultado.count };
    },
  };

  // Adaptador de búsquedas: crea rondas, reclama tandas y actualiza su estado en la base.
  const busquedas = {
    // Busca la ronda activa de una solicitud.
    obtenerActiva: (solicitudId, tx) => (tx ?? prisma).busqueda.findFirst({
      where: { solicitudId, estado: "activa" },
      select: { busquedaId: true, ronda: true, venceEn: true, candidatosRestantes: true, proximaTandaEn: true },
    }),
    // Registra una nueva ronda con su vencimiento y la hora de la próxima tanda.
    crear: ({ solicitudId, ronda = 1, venceEn, candidatosRestantes, proximaTandaEn }, tx) => (tx ?? prisma).busqueda.create({
      data: { solicitudId, ronda, venceEn, candidatosRestantes, proximaTandaEn },
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
    ? crearClienteHttp({ baseUrl: process.env.M2_URL, tokenPorDefecto: obtenerTokenM2, timeoutMs: 3000, reintentos: 2, logger })
    : null;
  if (!m2) throw new Error("M2_URL debe configurarse para validar el estado de la cuenta antes del alta");
  const m3 = crearClienteHttp({ baseUrl: process.env.M3_URL, tokenPorDefecto: process.env.M3_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m4 = crearClienteHttp({ baseUrl: process.env.M4_URL, tokenPorDefecto: process.env.M4_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m6 = crearClienteHttp({ baseUrl: process.env.M6_URL, tokenPorDefecto: process.env.M6_TOKEN, timeoutMs: 3000, reintentos: 2, logger });
  const m7 = process.env.M7_URL
    ? crearClienteHttp({ baseUrl: process.env.M7_URL, tokenPorDefecto: process.env.M7_TOKEN, timeoutMs: 3000, reintentos: 2, logger })
    : null;
  const m9 = crearClienteHttp({ baseUrl: process.env.M9_URL || "http://localhost:8089", timeoutMs: 3000, reintentos: 2, logger });
  const m8Outbox = process.env.M8_URL
    ? crearOutboxM8({
      prisma,
      clienteM8: crearClienteHttp({ baseUrl: process.env.M8_URL, timeoutMs: 3000, reintentos: 0, logger }),
      obtenerToken: obtenerTokenServicio,
      logger,
    })
    : null;
  const rutas = {
    m3EnviarOfertas: () => process.env.M3_RUTA_ENVIAR_OFERTAS || "/api/v1/integration/m5/offers",
    m6ConductorAsignado: () => process.env.M6_RUTA_CREAR_VIAJE || "/trips",
    m4ReservarConductor: ({ conductorId }) => `/api/v1/conductores/${encodeURIComponent(conductorId)}/reserva`,
    m4LiberarConductor: ({ conductorId }) => `/api/v1/conductores/${encodeURIComponent(conductorId)}/reserva`,
  };
  const persistencia = crearPersistencia(prisma);
  const notificarResultadoReserva = async ({ solicitudId, resultado, fecha }) => {
    const viaje = await persistencia.solicitudes.obtenerDatosViaje(solicitudId);
    if (!viaje?.reservaId) return { omitido: true };
    const token = await obtenerTokenServicio();
    const claveIdempotencia = crypto.createHash("sha256")
      .update(`${viaje.reservaId}:${solicitudId}:${resultado}`)
      .digest("hex");
    return m9.post(
      `/reservas/${encodeURIComponent(viaje.reservaId)}/despacho`,
      { solicitud_id: solicitudId, resultado, fecha: fecha.toISOString() },
      { token, claveIdempotencia }
    );
  };
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
      if (!respuesta) return null;
      if (respuesta.habilitado !== true || respuesta.disponible !== true) {
        throw Object.assign(new Error("M3 informa que el conductor ya no está habilitado o disponible."), { estado: 409 });
      }
      if ((respuesta?.conductor_id ?? conductorId) !== conductorId || !respuesta?.vehiculo?.vehiculo_id) return null;
      return {
        vehiculoId: String(respuesta.vehiculo.vehiculo_id),
        tipoVehiculo: respuesta.vehiculo.tipo_vehiculo,
      };
    },
    solicitudes: persistencia.solicitudes,
    encolarEventosM8: process.env.M8_URL
      ? async (datos) => m8Outbox.encolarEventosViaje(datos)
      : undefined,
  });
  const buscador = crearBuscadorCandidatos({
    clienteM4: {
      consultarM4: (pedido) => {
        const query = new URLSearchParams({
          origen_latitud: String(pedido.origen_latitud),
          origen_longitud: String(pedido.origen_longitud),
          tipo_vehiculo: String(pedido.tipo_vehiculo),
          limite: String(pedido.limite),
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
    notificarResultadoReserva,
    outboxM8: m8Outbox,
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
    const tarifa = await m7.post(process.env.M7_RUTA_ESTIMACION || "/api/v1/tarifas/estimaciones", {
      tipo_vehiculo: tipoVehiculo === "MOTO" ? "moto" : "auto",
      distancia_km: distancia,
      duracion_estimada_min: Math.ceil(eta),
    });
    return { ...tarifa, distancia_estimada_km: distancia, duracion_estimada_min: Math.ceil(eta) };
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
  // En las rutas publicadas del contrato, los errores usan el formato Problema de OpenAPI.
  // Se conserva `error` como campo de compatibilidad para el BFF del frontend.
  app.use((req, res, next) => {
    const rutaContrato = req.path.startsWith("/solicitudes") || req.path.startsWith("/conductores/") || req.path.startsWith("/api/v1/ofertas/");
    const json = res.json.bind(res);
    res.json = (body) => {
      if (!rutaContrato || res.statusCode < 400) return json(body);
      const status = res.statusCode;
      const titulos = { 400: "Solicitud inválida", 401: "No autenticado", 403: "Prohibido", 404: "No encontrado", 409: "Conflicto", 410: "Oferta no vigente", 422: "Solicitud no procesable", 503: "Servicio no disponible" };
      const detalle = typeof body?.error === "string" ? body.error
        : typeof body?.error?.mensaje === "string" ? body.error.mensaje
          : typeof body?.detail === "string" ? body.detail : "No se pudo completar la operación.";
      const codigo = body?.codigo || body?.error?.codigo;
      const tipo = String(codigo || titulos[status] || "error").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      res.type("application/problem+json");
      return json({ type: `urn:m5:problema:${tipo}`, title: titulos[status] || "Error", status, detail: detalle, error: detalle, ...(codigo ? { codigo } : {}), ...(body?.motivo ? { motivo: body.motivo } : {}) });
    };
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

  // El BFF usa un secreto privado; los consumidores del contrato usan JWT Bearer.
  const esTokenInternoValido = (req) => {
    const recibido = req.get("x-m5-internal-token") || "";
    const a = Buffer.from(recibido);
    const b = Buffer.from(TOKEN_INTERNO);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const autenticarApi = (req, res, next) => {
    if (esTokenInternoValido(req)) {
      req.esInterno = true;
      return next();
    }
    if (!verificador) return res.status(401).json({ error: "Autenticación requerida." });
    return autenticar(verificador)(req, res, next);
  };
  const esOperadorOServicio = (identidad) =>
    identidad?.roles?.some((rol) => ["OPERADOR", "ADMINISTRADOR", "SOLICITUD-BE", "SERVICIO", "SERVICE"].includes(rol));
  const puedeVerSolicitud = (req, solicitud) =>
    req.esInterno || esOperadorOServicio(req.identidad) || req.identidad?.identidadId === solicitud.idCliente;
  const validarRolClienteSiJwt = (req, res) => {
    if (req.esInterno || req.identidad?.roles?.some((rol) => ["CLIENTE", "CLIENTES-BE"].includes(rol))) return true;
    res.status(403).json({ error: "Se requiere el rol CLIENTE." });
    return false;
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
    return autenticarApi(req, res, next);
  });

  // RF-5.1: obtiene distancia y duración de M4 y pide a M7 el cálculo de tarifa.
  app.post("/solicitudes/estimacion", async (req, res, next) => {
    try {
      if (!validarRolClienteSiJwt(req, res)) return;
      if (typeof estimarTarifa !== "function") return res.status(503).json({ error: "La integración con M7 no está configurada." });
      const body = req.body || {};
      const origen = body.origen || { lat: body.origen_latitud, lng: body.origen_longitud };
      const destino = body.destino || { lat: body.destino_latitud, lng: body.destino_longitud };
      const tipoVehiculo = body.tipoVehiculo || body.tipo_vehiculo;
      if (!origen || !destino) return res.status(400).json({ error: "Seleccioná origen y destino para calcular el costo." });
      const tarifa = await estimarTarifa({ origen, destino, tipoVehiculo });
      const total = Number(tarifa?.desglose?.total ?? tarifa?.total_estimado);
      const distancia = Number(tarifa?.distancia_estimada_km);
      const duracion = Number(tarifa?.duracion_estimada_min);
      if (!Number.isFinite(total) || total < 0 || !Number.isFinite(distancia) || distancia <= 0 || !Number.isFinite(duracion) || duracion <= 0) {
        throw Object.assign(new Error("M4 o M7 devolvió una estimación incompleta."), { status: 502 });
      }
      const moneda = tarifa?.moneda || "ARS";
      res.json({
        moneda,
        total_estimado: total,
        ...(tarifa?.desglose ? { desglose: tarifa.desglose } : {}),
        distancia_estimada_km: distancia,
        duracion_estimada_min: duracion,
      });
    } catch (error) { next(error); }
  });

  // Crea un viaje inmediato desde el frontend y arranca el despacho sin demorar la respuesta HTTP.
  app.post("/solicitudes", async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!validarRolClienteSiJwt(req, res)) return;
      const idCliente = req.esInterno ? body.idCliente : req.identidad?.identidadId;
      if (!idCliente || (body.cliente_id && String(body.cliente_id) !== String(idCliente))) {
        return res.status(body.cliente_id ? 403 : 400).json({ error: "El cliente no coincide con la identidad autenticada." });
      }
      const origen = body.origen || { lat: body.origen_latitud, lng: body.origen_longitud };
      const destino = body.destino || { lat: body.destino_latitud, lng: body.destino_longitud };
      const tipoVehiculo = body.tipoVehiculo || body.tipo_vehiculo;
      if (!origen || !destino || !["AUTO", "MOTO"].includes(tipoVehiculo)) {
        return res.status(400).json({ error: "Se requieren origen, destino y tipo_vehiculo (AUTO o MOTO)." });
      }
      const clave = req.get("Idempotency-Key") || (req.esInterno ? crypto.randomUUID() : "");
      if (!clave || clave.length > 128) return res.status(400).json({ error: "Se requiere Idempotency-Key de hasta 128 caracteres." });
      const origenValidado = validarPunto(origen, "origen");
      const destinoValidado = validarPunto(destino, "destino");
      const operacion = "POST:/solicitudes";
      const huellaSolicitud = crypto.createHash("sha256").update(JSON.stringify({
        idCliente: String(idCliente), origen: origenValidado, destino: destinoValidado, tipoVehiculo,
      })).digest("hex");
      const emailCliente = req.identidad?.email ||
        (req.esInterno && typeof body.cliente_email === "string" ? body.cliente_email : null);
      const requestIdM6 = crypto.randomUUID();
      const claveIdempotencia = { clave, operacion, identidadId: String(idCliente) };
      const previa = await prisma.idempotenciaSolicitud.findUnique({ where: { clave_operacion_identidadId: claveIdempotencia } });
      if (previa) {
        if (previa.huellaSolicitud !== huellaSolicitud) return res.status(409).json({ error: "Idempotency-Key ya fue usada con datos diferentes." });
        const fila = await prisma.solicitud.findUnique({ where: { idSolicitud: previa.solicitudId } });
        if (!fila) return res.status(409).json({ error: "La solicitud asociada a la clave idempotente no existe." });
        res.location(`/solicitudes/${encodeURIComponent(fila.idSolicitud)}`);
        return res.status(200).json(mapSolicitud(fila));
      }
      await validarCliente(String(idCliente));
      const tarifa = await estimarTarifa({ origen: origenValidado, destino: destinoValidado, tipoVehiculo });
      const costo = Number(tarifa?.desglose?.total ?? tarifa?.total_estimado);
      if (!Number.isFinite(costo) || costo < 0 || !/^[A-Z]{3}$/.test(String(tarifa?.moneda || ""))) {
        throw Object.assign(new Error("M7 no devolvió una tarifa estimada válida."), { status: 502 });
      }

      let repetida = false;
      let solicitud;
      try {
        const resultado = await prisma.$transaction(async (tx) => {
          const existente = await tx.idempotenciaSolicitud.findUnique({ where: { clave_operacion_identidadId: claveIdempotencia } });
          if (existente) {
            if (existente.huellaSolicitud !== huellaSolicitud) throw Object.assign(new Error("Idempotency-Key ya fue usada con datos diferentes."), { status: 409 });
            const fila = await tx.solicitud.findUnique({ where: { idSolicitud: existente.solicitudId } });
            if (!fila) throw Object.assign(new Error("La solicitud asociada a la clave idempotente no existe."), { status: 409 });
            return { fila, repetida: true };
          }
          const fila = await tx.solicitud.create({ data: {
            idCliente: String(idCliente),
            emailCliente: emailValido(emailCliente) ? emailCliente : null,
            origenLat: origenValidado.lat, origenLng: origenValidado.lng,
            destinoLat: destinoValidado.lat, destinoLng: destinoValidado.lng,
            tipoVehiculo, vehiculo_id: null, costo, moneda: tarifa.moneda || "ARS",
            tipoActivacion: "Inmediata", reservaId: null, requestIdM6, intentoDespacho: 1,
            viajeId: null, estado: "pendiente",
          } });
          await tx.idempotenciaSolicitud.create({ data: {
            ...claveIdempotencia, huellaSolicitud, solicitudId: fila.idSolicitud,
          } });
          await tx.evento.create({ data: {
            solicitudId: fila.idSolicitud, tipo: TipoEvento.SOLICITUD_CREADA, ocurridoEn: new Date(),
            detalle: "Solicitud inmediata creada",
          } });
          return { fila, repetida: false };
        });
        solicitud = resultado.fila;
        repetida = resultado.repetida;
      } catch (error) {
        if (error.code !== "P2002") throw error;
        const existente = await prisma.idempotenciaSolicitud.findUnique({ where: { clave_operacion_identidadId: claveIdempotencia } });
        if (!existente) throw error;
        if (existente.huellaSolicitud !== huellaSolicitud) throw Object.assign(new Error("Idempotency-Key ya fue usada con datos diferentes."), { status: 409 });
        solicitud = await prisma.solicitud.findUnique({ where: { idSolicitud: existente.solicitudId } });
        if (!solicitud) throw error;
        repetida = true;
      }
      res.location(`/solicitudes/${encodeURIComponent(solicitud.idSolicitud)}`);
      if (!repetida) void app.locals.despacharSolicitud({
        solicitudId: solicitud.idSolicitud,
        origen: { latitud: solicitud.origenLat, longitud: solicitud.origenLng },
        destino: { latitud: solicitud.destinoLat, longitud: solicitud.destinoLng },
        tipoVehiculo,
        ronda: solicitud.intentoDespacho ?? 1,
      }, req.log);
      return res.status(repetida ? 200 : 201).json(mapSolicitud(solicitud));
    } catch (error) {
      if (error.code === "P2002") return res.status(409).json({ error: "Ya existe una solicitud para ese reservaId." });
      return next(error);
    }
  });

  // RF-5.2: recibe de M9 una reserva activada. Solo acepta tokens de servicio autorizados.
  app.post("/solicitudes/desde-reserva", autenticar(verificador), requerirRol("SERVICIO", "reservas-be"), async (req, res, next) => {
    try {
      const body = req.body || {};
      const idCliente = String(body.cliente_id || "").trim();
      const tipoVehiculo = String(body.tipo_vehiculo || "").toUpperCase();
      const origenRaw = { lat: Number(body.origen_latitud), lng: Number(body.origen_longitud) };
      const destinoRaw = { lat: Number(body.destino_latitud), lng: Number(body.destino_longitud) };
      const reservaId = String(body.reserva_id || "").trim();
      const emailCliente = body.cliente_email == null ? null : String(body.cliente_email).trim();
      if (!idCliente || !reservaId || !["AUTO", "MOTO"].includes(tipoVehiculo) ||
          ![origenRaw.lat, origenRaw.lng, destinoRaw.lat, destinoRaw.lng].every(Number.isFinite)) {
        return res.status(400).json({ error: "El cuerpo de activación de reserva está incompleto o es inválido." });
      }
      if (emailCliente && !emailValido(emailCliente)) return res.status(400).json({ error: "cliente_email debe ser una dirección válida." });
      const origen = validarPunto(origenRaw, "origen");
      const destino = validarPunto(destinoRaw, "destino");
      const activarExistente = async (existente) => {
        const coincide = existente.idCliente === idCliente &&
          existente.origenLat === origen.lat && existente.origenLng === origen.lng &&
          existente.destinoLat === destino.lat && existente.destinoLng === destino.lng &&
          existente.tipoVehiculo === tipoVehiculo;
        if (!coincide) return res.status(409).json({ error: "La reserva ya fue activada con datos diferentes." });
        return res.status(200).json({ reserva_id: existente.reservaId, solicitud_id: existente.idSolicitud, estado: existente.estado });
      };
      const reservaPrevia = await prisma.solicitud.findUnique({ where: { reservaId } });
      if (reservaPrevia) return activarExistente(reservaPrevia);
      await validarCliente(idCliente);
      const tarifa = body.tarifa_estimada
        ? { moneda: body.tarifa_estimada.moneda, total_estimado: body.tarifa_estimada.total_estimado }
        : await estimarTarifa({ origen, destino, tipoVehiculo });
      const costo = Number(tarifa?.desglose?.total ?? tarifa?.total_estimado);
      if (!Number.isFinite(costo) || costo < 0 || !/^[A-Z]{3}$/.test(String(tarifa?.moneda || ""))) {
        throw Object.assign(new Error("La tarifa estimada de la reserva es inválida."), { status: body.tarifa_estimada ? 400 : 502 });
      }
      const solicitud = await prisma.$transaction(async (tx) => {
        const fila = await tx.solicitud.create({ data: {
          idCliente, emailCliente, origenLat: origen.lat, origenLng: origen.lng,
          destinoLat: destino.lat, destinoLng: destino.lng,
          tipoVehiculo, vehiculo_id: null, costo, moneda: tarifa.moneda || "ARS",
          tipoActivacion: "Reserva", reservaId, requestIdM6: crypto.randomUUID(),
          intentoDespacho: 1, viajeId: null, estado: "pendiente",
        } });
        await tx.evento.create({ data: {
          solicitudId: fila.idSolicitud, tipo: TipoEvento.SOLICITUD_CREADA, ocurridoEn: new Date(),
          detalle: `Solicitud creada desde reserva ${reservaId}`,
        } });
        return fila;
      });
      res.location(`/solicitudes/${encodeURIComponent(solicitud.idSolicitud)}`);
      void app.locals.despacharSolicitud({
        solicitudId: solicitud.idSolicitud,
        origen: { latitud: solicitud.origenLat, longitud: solicitud.origenLng },
        destino: { latitud: solicitud.destinoLat, longitud: solicitud.destinoLng },
        tipoVehiculo,
        ronda: solicitud.intentoDespacho ?? 1,
      }, req.log);
      return res.status(201).json({ reserva_id: reservaId, solicitud_id: solicitud.idSolicitud, estado: solicitud.estado });
    } catch (error) {
      if (error.code === "P2002") {
        const existente = await prisma.solicitud.findUnique({ where: { reservaId: String(req.body?.reserva_id || "") } });
        if (existente) {
          const b = req.body || {};
          const coincide = existente.idCliente === String(b.cliente_id || "") &&
            existente.origenLat === Number(b.origen_latitud) && existente.origenLng === Number(b.origen_longitud) &&
            existente.destinoLat === Number(b.destino_latitud) && existente.destinoLng === Number(b.destino_longitud) &&
            existente.tipoVehiculo === String(b.tipo_vehiculo || "").toUpperCase();
          if (!coincide) return res.status(409).json({ error: "La reserva ya fue activada con datos diferentes." });
          return res.status(200).json({ reserva_id: existente.reservaId, solicitud_id: existente.idSolicitud, estado: existente.estado });
        }
      }
      return next(error);
    }
  });

  // Devuelve las solicitudes para el panel de administración del frontend.
  app.get("/solicitudes", async (req, res, next) => {
    try {
      if (!req.esInterno && !esOperadorOServicio(req.identidad)) return res.status(403).json({ error: "Se requiere rol de operador o servicio." });
      const rows = await prisma.solicitud.findMany({ orderBy: { creadaEn: "desc" } });
      res.json(rows.map(mapSolicitud));
    } catch (error) { next(error); }
  });

  // Consulta de ofertas para operación/auditoría del módulo.
  app.get("/solicitudes/:id/ofertas", async (req, res, next) => {
    try {
      const solicitud = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (!req.esInterno && !esOperadorOServicio(req.identidad)) return res.status(403).json({ error: "Se requiere rol de operador o servicio." });
      const filas = await deps.ofertas.listarPorSolicitud(req.params.id);
      return res.json(filas.map(mapOfertaContrato));
    } catch (error) { return next(error); }
  });

  // Devuelve el historial persistido en orden cronológico, como exige el contrato.
  app.get("/solicitudes/:id/historial", async (req, res, next) => {
    try {
      const solicitud = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (!puedeVerSolicitud(req, solicitud)) return res.status(403).json({ error: "No tenés permiso para consultar esta solicitud." });
      const eventos = await prisma.evento.findMany({ where: { solicitudId: req.params.id }, orderBy: [{ ocurridoEn: "asc" }, { eventoId: "asc" }] });
      return res.json(eventos.map(mapEventoContrato));
    } catch (error) { return next(error); }
  });

  // El conductor consulta solo sus ofertas; operadores y servicios pueden consultar cualquier conductor.
  app.get("/conductores/:conductorId/ofertas", autenticarApi, async (req, res, next) => {
    try {
      const conductorId = req.params.conductorId;
      const estado = req.query.estado ? String(req.query.estado).toLowerCase() : undefined;
      const estadosValidos = ["pendiente", "aceptada", "rechazada", "vencida", "cancelada"];
      if (estado && !estadosValidos.includes(estado)) return res.status(400).json({ error: "El estado de oferta no es válido." });
      const identidadConductor = req.identidad?.conductorId || req.identidad?.identidadId;
      if (!req.esInterno && !esOperadorOServicio(req.identidad) && identidadConductor !== conductorId) {
        return res.status(403).json({ error: "Solo podés consultar tus propias ofertas." });
      }
      const filas = await deps.ofertas.listarPorConductor({ conductorId, estado });
      return res.json(filas.map(mapOfertaContrato));
    } catch (error) { return next(error); }
  });

  // Devuelve el estado actual para que el frontend pueda reflejar los cambios del despacho.
  app.get("/solicitudes/:id", async (req, res, next) => {
    try {
      const row = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!row) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (!puedeVerSolicitud(req, row)) return res.status(403).json({ error: "No tenés permiso para consultar esta solicitud." });
      return res.json(mapSolicitud(row));
    } catch (error) { next(error); }
  });

  // Cancela una solicitud que todavía no fue asignada y ejecuta la limpieza de ofertas y reservas.
  app.post("/solicitudes/:id/cancelar", async (req, res, next) => {
    try {
      const actual = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!actual) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (!validarRolClienteSiJwt(req, res)) return;
      if (!req.esInterno && req.identidad?.identidadId !== actual.idCliente) return res.status(403).json({ error: "Solo el cliente titular puede cancelar esta solicitud." });
      if (req.body?.motivo != null && (typeof req.body.motivo !== "string" || req.body.motivo.length > 500)) {
        return res.status(400).json({ error: "motivo debe ser texto de hasta 500 caracteres." });
      }
      const cambio = await prisma.solicitud.updateMany({
        where: { idSolicitud: req.params.id, estado: { in: ["pendiente", "PENDIENTE_ASIGNACION", "buscando"] } },
        data: { estado: "cancelada" },
      });
      const solicitud = await prisma.solicitud.findUnique({ where: { idSolicitud: req.params.id } });
      if (!solicitud) return res.status(404).json({ error: "Solicitud no encontrada." });
      if (cambio.count) {
        const motivo = String(req.body?.motivo || "CANCELADA_POR_CLIENTE").slice(0, 500);
        await procesarCancelacionSolicitud({ solicitudId: req.params.id, motivo }, deps);
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
  const trabajoM8 = deps.outboxM8?.iniciar();
  if (!process.env.M8_URL) logger.warn("M8_URL no está configurada; los eventos de viaje no se enviarán a M8");
  const consumidorM6 = process.env.M6_RABBITMQ_URL
    ? iniciarConsumidorM6({
      url: process.env.M6_RABBITMQ_URL,
      logger,
      procesarEvento: (evento) => procesarCancelacionM6(evento, {
        prisma,
        logger,
        alRedespachar: (solicitud) => app.locals.despacharSolicitud(solicitud, logger),
      }),
    })
    : null;
  if (!consumidorM6) logger.warn("M6_RABBITMQ_URL no está configurada; no se consumirán cancelaciones de M6");

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
            ronda: fila.intentoDespacho ?? 1,
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
    trabajoM8?.detener();
    await consumidorM6?.detener();
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  };
  process.once("SIGINT", cerrar);
  process.once("SIGTERM", cerrar);
  return { app, server, prisma, deps, consumidorM6, cerrar };
}

// Verifica los JWT de Keycloak con sus claves públicas remotas y extrae identidad, roles y conductor.
async function crearVerificadorKeycloak() {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const keycloakUrl = (process.env.KEYCLOAK_URL || "").replace(/\/$/, "");
  const realm = process.env.KEYCLOAK_REALM || "";
  if (!keycloakUrl || !realm) throw new Error("KEYCLOAK_URL y KEYCLOAK_REALM son obligatorios para validar respuestas de M3");
  const issuer = `${keycloakUrl}/realms/${encodeURIComponent(realm)}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  const audiencia = process.env.JWT_AUDIENCE || undefined;
  const configClaims = {
    claimIdentidad: process.env.JWT_CLAIM_IDENTIDAD || "sub",
    claimRoles: process.env.JWT_CLAIM_ROLES || "realm_access.roles",
    claimScopes: process.env.JWT_CLAIM_SCOPES || "scope",
    claimConductor: process.env.JWT_CLAIM_CONDUCTOR || "conductor_id",
    claimEmail: process.env.JWT_CLAIM_EMAIL || "email",
  };
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        algorithms: ["RS256"],
        ...(audiencia ? { audience: audiencia } : {}),
      });
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
