const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const app = express();
const PORT = Number(process.env.API_PORT) || 3000;

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'despacho',
  connectionLimit: 5,
});
const prisma = new PrismaClient({ adapter });
app.use(express.json({ limit: '1mb' }));

function coordDecimal(value, min, max, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${field} debe ser un número entre ${min} y ${max}.`);
  }
  return n;
}
function mapSolicitud(row) {
  return {
    solicitudId: row.idSolicitud,
    clienteId: row.idCliente,
    origen: { lat: row.origenLat, lng: row.origenLng },
    destino: { lat: row.destinoLat, lng: row.destinoLng },
    tipoVehiculo: row.tipoVehiculo,
    tipoActivacion: row.tipoActivacion,
    reservaId: row.reservaId,
    conductorId: row.conductorId,
    estado: row.estado,
    creadaEn: row.creadaEn,
  };
}

app.post('/solicitudes', async (req, res) => {
  try {
    const body = req.body || {};
    const idCliente = String(body.idCliente || '').trim();
    const { origen, destino, tipoVehiculo } = body;
    const tipoActivacion = body.tipoActivacion || 'Inmediata';
    const reservaId = body.reservaId ? String(body.reservaId) : null;

    if (!idCliente || !origen || !destino || !['AUTO', 'MOTO'].includes(tipoVehiculo)) {
      return res.status(400).json({ error: 'Se requieren idCliente, origen, destino y tipoVehiculo (AUTO o MOTO).' });
    }
    if (!['Inmediata', 'Reserva'].includes(tipoActivacion)) {
      return res.status(400).json({ error: 'tipoActivacion debe ser Inmediata o Reserva.' });
    }
    if (tipoActivacion === 'Reserva' && !reservaId) {
      return res.status(400).json({ error: 'Una solicitud de Reserva requiere reservaId.' });
    }

    const nueva = await prisma.solicitud.create({
      data: {
        idCliente,
        origenLat: coordDecimal(origen.lat, -90, 90, 'origen.lat'),
        origenLng: coordDecimal(origen.lng, -180, 180, 'origen.lng'),
        destinoLat: coordDecimal(destino.lat, -90, 90, 'destino.lat'),
        destinoLng: coordDecimal(destino.lng, -180, 180, 'destino.lng'),
        tipoVehiculo,
        tipoActivacion,
        reservaId,
        conductorId: null,
        creadaEn: new Date(),
      },
    });
    return res.status(201).json(mapSolicitud(nueva));
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una solicitud para ese reservaId.' });
    }
    console.error('Error al crear solicitud:', error);
    return res.status(400).json({ error: error.message || 'No se pudo guardar la solicitud en la base de datos.' });
  }
});

app.get('/solicitudes', async (_req, res) => {
  try {
    const rows = await prisma.solicitud.findMany({ orderBy: { creadaEn: 'desc' } });
    return res.status(200).json(rows.map(mapSolicitud));
  } catch (error) {
    console.error('Error al consultar solicitudes:', error);
    return res.status(500).json({ error: 'No se pudieron consultar las solicitudes.' });
  }
});

app.patch('/solicitudes/:id/cancelar', async (req, res) => {
  try {
    const cancelada = await prisma.solicitud.update({
      where: { idSolicitud: req.params.id },
      data: { estado: 'CANCELADA' },
    });
    return res.status(200).json(mapSolicitud(cancelada));
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Solicitud no encontrada.' });
    console.error('Error al cancelar solicitud:', error);
    return res.status(500).json({ error: 'No se pudo cancelar la solicitud.' });
  }
});

app.delete('/solicitudes/:id', async (req, res) => {
  try {
    const eliminada = await prisma.solicitud.delete({
      where: { idSolicitud: req.params.id },
    });
    return res.status(200).json({ eliminado: true, solicitudId: eliminada.idSolicitud });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Solicitud no encontrada.' });
    console.error('Error al eliminar solicitud:', error);
    return res.status(500).json({ error: 'No se pudo eliminar la solicitud.' });
  }
});

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ estado: 'ok', baseDeDatos: 'conectada' });
  } catch (error) {
    res.status(503).json({ estado: 'error', baseDeDatos: 'no disponible' });
  }
});

const server = app.listen(PORT, () => console.log(`API de solicitudes: http://localhost:${PORT}`));
async function shutdown() { server.close(); await prisma.$disconnect(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
