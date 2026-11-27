const crypto = require("node:crypto");

const TIPOS_VIAJE = ["VIAJE_SOLICITADO", "VIAJE_ASIGNADO"];
const MAX_INTENTOS = 8;
const MAX_ESPERA_MS = 5 * 60_000;

function crearOutboxM8({ prisma, clienteM8, obtenerToken, logger, reloj = () => new Date() }) {
  if (!prisma?.notificacionM8 || typeof clienteM8?.post !== "function" || typeof obtenerToken !== "function") {
    throw new Error("Faltan dependencias para el outbox de M8");
  }
  let cicloEnCurso = false;
  let temporizador = null;

  async function encolarEventosViaje({ solicitudId, requestIdM6, viajeId, datosViaje }) {
    if (!solicitudId || !requestIdM6 || !viajeId || !datosViaje?.clienteId) {
      throw new Error("Faltan datos para encolar los eventos de viaje de M8");
    }

    const destinatario = {
      usuarioId: datosViaje.clienteId,
      rol: "CLIENTE",
      ...(datosViaje.clienteEmail ? { email: datosViaje.clienteEmail } : {}),
    };
    const reservaId = datosViaje.reservaId || undefined;
    const importe = Number.isFinite(Number(datosViaje.costo)) && datosViaje.moneda
      ? { monto: Number(datosViaje.costo), moneda: datosViaje.moneda }
      : undefined;
    const ocurridoSolicitud = datosViaje.creadaEn
      ? new Date(datosViaje.creadaEn).toISOString()
      : reloj().toISOString();
    const ocurridoAsignacion = reloj().toISOString();

    for (const tipo of TIPOS_VIAJE) {
      const cuerpo = {
        eventoId: crypto.randomUUID(),
        tipo,
        origen: "M5",
        ocurridoEn: tipo === "VIAJE_SOLICITADO" ? ocurridoSolicitud : ocurridoAsignacion,
        viajeId,
        ...(reservaId ? { reservaId } : {}),
        destinatarios: [destinatario],
        detalle: {
          tipoVehiculo: datosViaje.tipoVehiculo,
          ...(importe ? { importe } : {}),
        },
      };

      await prisma.notificacionM8.upsert({
        where: {
          solicitudId_requestIdM6_tipo: { solicitudId, requestIdM6, tipo },
        },
        create: { solicitudId, requestIdM6, tipo, cuerpo },
        update: {},
      });
    }
  }

  async function ciclo() {
    if (cicloEnCurso) return { omitido: true };
    cicloEnCurso = true;
    const resumen = { enviadas: 0, reintentadas: 0, fallidas: 0 };
    try {
      const ahora = reloj();
      const pendientes = await prisma.notificacionM8.findMany({
        where: { estado: "PENDIENTE", proximoIntento: { lte: ahora } },
        orderBy: [{ creadoEn: "asc" }, { eventoId: "asc" }],
        take: 25,
      });

      for (const evento of pendientes) {
        if (evento.tipo === "VIAJE_ASIGNADO") {
          const anterior = await prisma.notificacionM8.findFirst({
            where: {
              solicitudId: evento.solicitudId,
              requestIdM6: evento.requestIdM6,
              tipo: "VIAJE_SOLICITADO",
              estado: { not: "ENVIADA" },
            },
            select: { eventoId: true },
          });
          if (anterior) continue;
        }

        const intento = evento.intentos + 1;
        try {
          const token = await obtenerToken();
          await clienteM8.post("/api/v1/eventos", evento.cuerpo, {
            token,
            claveIdempotencia: evento.eventoId,
          });
          await prisma.notificacionM8.updateMany({
            where: { eventoId: evento.eventoId, estado: "PENDIENTE" },
            data: { estado: "ENVIADA", intentos: intento, enviadoEn: reloj(), ultimoError: null },
          });
          resumen.enviadas += 1;
        } catch (error) {
          const reintentable = !Number.isInteger(error?.estado) || error.estado === 429 || error.estado >= 500;
          const reintentar = reintentable && intento < MAX_INTENTOS;
          const espera = Math.max(
            error?.retryAfterMs || 0,
            Math.min(1000 * (2 ** (intento - 1)), MAX_ESPERA_MS)
          );
          await prisma.notificacionM8.updateMany({
            where: { eventoId: evento.eventoId, estado: "PENDIENTE" },
            data: {
              estado: reintentar ? "PENDIENTE" : "FALLIDA",
              intentos: intento,
              proximoIntento: new Date(reloj().getTime() + espera),
              ultimoError: String(error?.message || error).slice(0, 1000),
            },
          });
          logger?.error({ err: error, eventoId: evento.eventoId, tipo: evento.tipo, intento }, "falló el envío de un evento a M8");
          if (reintentar) resumen.reintentadas += 1;
          else resumen.fallidas += 1;
        }
      }
    } finally {
      cicloEnCurso = false;
    }
    return resumen;
  }

  function iniciar({ intervaloMs = 2000 } = {}) {
    if (temporizador) return { ciclo, detener };
    const ejecutar = () => {
      ciclo().catch((error) => logger?.error({ err: error }, "falló el ciclo del outbox de M8"));
    };
    temporizador = setInterval(ejecutar, intervaloMs);
    temporizador.unref?.();
    ejecutar();
    return { ciclo, detener };
  }

  function detener() {
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
  }

  return { encolarEventosViaje, ciclo, iniciar, detener };
}

module.exports = { crearOutboxM8 };
