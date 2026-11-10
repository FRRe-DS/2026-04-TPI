// void main() {
//    recibir_solicitud();
//    generar_solicitud();
//    crearInmediato();
//
//    buscar_conductor();
//    // recibir la lista de conductores disponibles
//    recibir_conductor(); 
//    enviar_mensaje_conductores();
//    cancelar_solicitud();
//
//    esperar_respuesta_conductor();
//    asignar_conductor();
//    notificar_usuario();
//    
//    mandar_mensaje_M6();
//    // guardar en la base de datos
//    Guardar_solicitud();
// }

require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const { crearApp, leerConfig, crearLogger, crearClienteHttp, crearVerificadorLocal } = require('./comun');
const { crearRouterRespuesta } = require('./respuesta/rutas');
const { crearRepositorioOfertas, crearEjecutarEnTransaccion } = require('./respuesta/repositorioOfertas');
const { crearRepositorioCandidatos } = require('./busqueda/repositorioCandidatos');
const { iniciarJobVencimientos } = require('./respuesta/jobVencimientos');

async function arrancarServidor() {
  const config = leerConfig();
  const logger = crearLogger({ nivel: config.nivelLog });
  
  // 1. Iniciamos Prisma
  const prisma = new PrismaClient();

  // 2. Creamos los clientes HTTP (RNF-13) para comunicarnos con otros módulos
  const clienteM6 = crearClienteHttp({ baseUrl: process.env.M6_URL || 'http://localhost:3006', logger });
  const clienteM4 = crearClienteHttp({ baseUrl: process.env.M4_URL || 'http://localhost:3004', logger });

  // 3. Implementamos los "Puertos" que faltaban (Solicitudes, Eventos y Notificaciones)
  const repositorioSolicitudes = {
    obtenerEstado: async (solicitudId, tx) => {
      const db = tx || prisma;
      const sol = await db.solicitud.findUnique({ where: { idSolicitud: solicitudId } });
      return sol ? { estado: sol.estado, conductorAsignadoId: sol.conductorId, ...sol } : null;
    },
    asignar: async ({ solicitudId, conductorId }, tx) => {
      const db = tx || prisma;
      // OJO: Usamos 'buscando' porque así está en src/comun/estados.js
      const r = await db.solicitud.updateMany({
        where: { idSolicitud: solicitudId, estado: 'buscando' },
        data: { estado: 'asignada', conductorId }
      });
      return { resultado: r.count === 1 ? 'asignada' : 'solicitud_no_buscando' };
    },
    marcarSinDisponibilidad: async ({ solicitudId, motivo }, tx) => {
      const db = tx || prisma;
      const r = await db.solicitud.updateMany({
        where: { idSolicitud: solicitudId, estado: 'buscando' },
        data: { estado: 'sin_disponibilidad' }
      });
      return { aplicado: r.count === 1, estadoActual: 'sin_disponibilidad' };
    }
  };

  const repositorioEventos = {
    registrar: async (datos, tx) => {
      const db = tx || prisma;
      await db.evento.create({ data: datos });
    }
  };

  // ACÁ OCURRE LA MAGIA CON M6: Implementamos el aviso al Módulo 6 (RF-6.1)
  const notificaciones = {
    conductorAsignado: async ({ solicitudId, conductorId, ofertaId }) => {
      // a) Buscamos los datos completos de la solicitud en M5
      const sol = await prisma.solicitud.findUnique({ where: { idSolicitud: solicitudId } });
      if (!sol) return;

      // b) Armamos el contrato exacto CreateTripRequest que exige M6
      const payloadM6 = {
        requestId: sol.idSolicitud,
        reservationId: sol.reservaId || null,
        clientId: sol.idCliente,
        driverId: conductorId,
        vehicleId: "uuid-vehiculo-mock", // M3 debería proveerlo, lo hardcodeamos por ahora
        vehicleType: sol.tipoVehiculo,
        originLatitude: sol.origenLat,
        originLongitude: sol.origenLng,
        destinationLatitude: sol.destinoLat,
        destinationLongitude: sol.destinoLng,
        originAddress: "Dirección M5",
        destinationAddress: "Dirección M5"
      };

      // c) Disparamos el POST a M6 con el token SYSTEM
      logger.info({ solicitudId }, "Avisando a M6 de la asignación del viaje...");
      await clienteM6.post('/trips', payloadM6, {
        claveIdempotencia: `asignacion-${solicitudId}`,
        token: process.env.TOKEN_SYSTEM_M5 || "jwt-simulado-para-desarrollo" 
      });
    },
    liberarConductores: async (lista) => {
      // Mock de liberación en M4 para que no falle la asignación
      logger.info({ lista }, "Liberando conductores en M4...");
      return lista.map(i => i.conductorId);
    }
  };

  // 4. Armamos el objeto de dependencias (deps) que inyectaremos en la lógica
  const deps = {
    solicitudes: repositorioSolicitudes,
    eventos: repositorioEventos,
    notificaciones: notificaciones,
    ofertas: crearRepositorioOfertas(prisma),
    candidatos: crearRepositorioCandidatos(prisma),
    busquedas: {
      obtenerActiva: async () => null, // Mock simple hasta que unifiquen la BD
      cerrar: async () => true
    },
    cacheOfertas: { eliminar: async () => {} }, // Mock de Redis (RNF-11)
    ejecutarEnTransaccion: crearEjecutarEnTransaccion(prisma),
    logger: logger
  };

  // 5. Instanciamos el router inyectando las dependencias
  const verificadorMock = async () => ({ identidadId: "123", roles: ["CONDUCTOR"] }); // Mock de M1
  const routerRespuesta = crearRouterRespuesta({ 
    deps, 
    requerirRol: () => (req, res, next) => next(), 
    validar: () => (req, res, next) => next() 
  });

  // 6. Levantamos Express con los middlewares ordenados
  const app = crearApp({
    config, logger, verificador: verificadorMock,
    registrarRutas: (aplicacion) => {
      aplicacion.use('/api', routerRespuesta);
    }
  });

  // 7. Arrancamos el cron job de vencimientos en segundo plano
  const job = iniciarJobVencimientos({ deps, logger });

  const servidor = app.listen(config.puerto, () => {
    logger.info(`✅ Servidor M5 (Lógica) corriendo en http://localhost:${config.puerto}`);
  });

  // Cierre ordenado
  const apagar = async () => {
    job.detener();
    servidor.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', apagar);
  process.on('SIGTERM', apagar);
}

arrancarServidor().catch(err => {
  console.error("Fallo fatal al arrancar:", err);
  process.exit(1);
});