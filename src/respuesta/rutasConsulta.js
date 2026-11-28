// Endpoints de consulta y auditoría de M5 (RF-5.4, RF-5.9):
//   - GET /solicitudes/:solicitudId/ofertas
//   - GET /conductores/:conductorId/ofertas?estado=
//   - GET /solicitudes/:solicitudId/historial
//
// Se mantiene desacoplado de src/respuesta/rutas.js y de src/main.js para facilitar
// el desarrollo en paralelo y montarlo en una línea junto al router de respuestas.
const express = require("express");
const { z } = require("zod");
const { ROLES, EstadoOferta, errores } = require("../comun");

const ROLES_PRIVILEGIADOS = new Set([ROLES.OPERADOR, ROLES.ADMINISTRADOR, "SERVICIO"]);

const esquemaParamsSolicitud = z
  .object({ solicitudId: z.string().uuid("solicitudId debe ser un UUID válido") })
  .strict();

const esquemaParamsConductor = z
  .object({ conductorId: z.string().uuid("conductorId debe ser un UUID válido") })
  .strict();

const esquemaQueryOfertasConductor = z.object({
  estado: z.enum(Object.values(EstadoOferta), {
    errorMap: () => ({ message: "estado debe ser pendiente, aceptada, rechazada, vencida o cancelada" }),
  }).optional(),
});

function aIso(valor) {
  return valor instanceof Date ? valor.toISOString() : new Date(valor).toISOString();
}

function mapearOferta(oferta) {
  return {
    oferta_id: oferta.ofertaId,
    solicitud_id: oferta.solicitudId,
    conductor_id: oferta.conductorId,
    estado: oferta.estado,
    creada_en: aIso(oferta.enviadaEn ?? oferta.creadaEn),
    vence_en: aIso(oferta.venceEn),
    ...(oferta.respondidaEn ? { respondida_en: aIso(oferta.respondidaEn) } : {}),
  };
}

const MAPA_TIPO_EVENTO_OPENAPI = Object.freeze({
  BUSQUEDA: "BUSQUEDA_INICIADA",
  OFERTA: "OFERTA_EMITIDA",
  ACEPTACION: "OFERTA_ACEPTADA",
  RECHAZO: "OFERTA_RECHAZADA",
  VENCIMIENTO: "OFERTA_VENCIDA",
});

function mapearTipoEvento(evento) {
  if (evento.tipo === "CANCELACION") {
    return evento.ofertaId ? "OFERTA_CANCELADA" : "SOLICITUD_CANCELADA";
  }
  return MAPA_TIPO_EVENTO_OPENAPI[evento.tipo] ?? evento.tipo;
}

function mapearEvento(evento) {
  return {
    id: evento.eventoId ?? evento.id,
    solicitud_id: evento.solicitudId,
    ...(evento.ofertaId ? { oferta_id: evento.ofertaId } : {}),
    ...(evento.conductorId ? { conductor_id: evento.conductorId } : {}),
    tipo: mapearTipoEvento(evento),
    fecha: aIso(evento.ocurridoEn ?? evento.fecha),
    ...(evento.detalle !== undefined && evento.detalle !== null ? { detalle: evento.detalle } : {}),
  };
}

function tieneRolPrivilegiado(identidad) {
  return Array.isArray(identidad?.roles) && identidad.roles.some((rol) => ROLES_PRIVILEGIADOS.has(rol));
}

// Adaptador sobre PrismaClient para usar directamente en src/main.js.
function crearConsultasPrisma(prisma) {
  return {
    async obtenerSolicitud(solicitudId) {
      const fila = await prisma.solicitud.findUnique({
        where: { idSolicitud: solicitudId },
        select: { idSolicitud: true, idCliente: true, estado: true },
      });
      return fila ? { solicitudId: fila.idSolicitud, clienteId: fila.idCliente, estado: fila.estado } : null;
    },
    listarOfertasDeSolicitud(solicitudId) {
      return prisma.oferta.findMany({
        where: { solicitudId },
        orderBy: [{ enviadaEn: "asc" }, { ofertaId: "asc" }],
        select: {
          ofertaId: true,
          solicitudId: true,
          conductorId: true,
          estado: true,
          enviadaEn: true,
          venceEn: true,
          respondidaEn: true,
        },
      });
    },
    listarOfertasDeConductor(conductorId, { estado } = {}) {
      return prisma.oferta.findMany({
        where: { conductorId, ...(estado ? { estado } : {}) },
        orderBy: [{ enviadaEn: "desc" }, { ofertaId: "asc" }],
        select: {
          ofertaId: true,
          solicitudId: true,
          conductorId: true,
          estado: true,
          enviadaEn: true,
          venceEn: true,
          respondidaEn: true,
        },
      });
    },
    listarHistorialSolicitud(solicitudId) {
      return prisma.evento.findMany({
        where: { solicitudId },
        orderBy: [{ ocurridoEn: "asc" }, { eventoId: "asc" }],
        select: {
          eventoId: true,
          solicitudId: true,
          ofertaId: true,
          conductorId: true,
          tipo: true,
          ocurridoEn: true,
          detalle: true,
        },
      });
    },
  };
}

function adaptarDesdeDeps(deps) {
  if (!deps?.solicitudes || !deps?.ofertas || !deps?.eventos) {
    throw new Error("crearRouterConsulta requiere `consultas`, `prisma` o `deps` completos");
  }
  return {
    obtenerSolicitud: (solicitudId) => deps.solicitudes.obtenerEstado(solicitudId),
    listarOfertasDeSolicitud: (solicitudId) => deps.ofertas.listarPorSolicitud(solicitudId),
    listarOfertasDeConductor: (conductorId, filtro) => deps.ofertas.listarPorConductor(conductorId, filtro),
    listarHistorialSolicitud: (solicitudId) => deps.eventos.listarPorSolicitud(solicitudId),
  };
}

function crearRouterConsulta({ consultas, prisma, deps, requerirRol, validar, resolverConductorId } = {}) {
  const fuente = consultas ?? (prisma ? crearConsultasPrisma(prisma) : adaptarDesdeDeps(deps));
  const router = express.Router();

  // RF-5.4 y RF-5.9: ofertas generadas para una solicitud (operadores o servicios autorizados).
  router.get(
    "/solicitudes/:solicitudId/ofertas",
    requerirRol(ROLES.OPERADOR, ROLES.ADMINISTRADOR, "SERVICIO"),
    validar({ params: esquemaParamsSolicitud }),
    async (req, res, next) => {
      try {
        const { solicitudId } = req.validado.params;
        const solicitud = await fuente.obtenerSolicitud(solicitudId);
        if (!solicitud) throw errores.noEncontrado("La solicitud no existe");
        const ofertas = await fuente.listarOfertasDeSolicitud(solicitudId);
        return res.status(200).json(ofertas.map(mapearOferta));
      } catch (error) {
        return next(error);
      }
    }
  );

  // Ofertas dirigidas a un conductor, con filtro opcional ?estado=.
  router.get(
    "/conductores/:conductorId/ofertas",
    requerirRol(ROLES.CONDUCTOR, ROLES.OPERADOR, ROLES.ADMINISTRADOR, "SERVICIO"),
    validar({ params: esquemaParamsConductor, query: esquemaQueryOfertasConductor }),
    async (req, res, next) => {
      try {
        const { conductorId } = req.validado.params;
        const { estado } = req.validado.query;
        if (!tieneRolPrivilegiado(req.identidad)) {
          const conductorToken = resolverConductorId
            ? await resolverConductorId(req.identidad)
            : (req.identidad.conductorId || req.identidad.identidadId);
          if (!conductorToken || String(conductorToken) !== conductorId) {
            throw errores.prohibido("No tenés permiso para consultar las ofertas de otro conductor");
          }
        }
        const ofertas = await fuente.listarOfertasDeConductor(conductorId, { estado });
        return res.status(200).json(ofertas.map(mapearOferta));
      } catch (error) {
        return next(error);
      }
    }
  );

  // RF-5.9: historial cronológico de eventos de despacho (cliente titular, operador o servicio).
  router.get(
    "/solicitudes/:solicitudId/historial",
    requerirRol(ROLES.CLIENTE, ROLES.OPERADOR, ROLES.ADMINISTRADOR, "SERVICIO"),
    validar({ params: esquemaParamsSolicitud }),
    async (req, res, next) => {
      try {
        const { solicitudId } = req.validado.params;
        const solicitud = await fuente.obtenerSolicitud(solicitudId);
        if (!solicitud) throw errores.noEncontrado("La solicitud no existe");
        if (!tieneRolPrivilegiado(req.identidad)) {
          if (!solicitud.clienteId || String(solicitud.clienteId) !== String(req.identidad.identidadId)) {
            throw errores.prohibido("No tenés permiso para consultar el historial de otra solicitud");
          }
        }
        const eventos = await fuente.listarHistorialSolicitud(solicitudId);
        const ordenados = [...eventos].sort(
          (a, b) => new Date(a.ocurridoEn ?? a.fecha).getTime() - new Date(b.ocurridoEn ?? b.fecha).getTime()
        );
        return res.status(200).json(ordenados.map(mapearEvento));
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = { crearRouterConsulta, crearConsultasPrisma, mapearOferta, mapearEvento };
