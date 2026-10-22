const express = require('express');
const { PrismaClient } = require('@prisma/client')
const { PrismaMariaDb } = require('@prisma/adapter-mariadb')
const app = express();

const adapter = new PrismaMariaDb({
    host: "localhost",
    port: 3306,
    user: "root",
    password: "password",
    database: "despacho",
    connectionLimit: 5,
});

const prisma = new PrismaClient({ adapter })

app.use(express.json());

app.post('/solicitudes', async (req, res) => {
    try {
        const { idCliente, origen, destino, tipoVehiculo } = req.body;
        const nueva = await prisma.solicitud.create({
            data: { idCliente, origen, destino, tipoVehiculo }
        });
        res.status(201).json(nueva);
    } catch (error) {
        console.error("Error al crear:", error);
        res.status(500).json({ error: "Fallo al crear la solicitud" });
    }
});

app.patch('/solicitudes/:id/cancelar', async (req, res) => {
    try {
        const cancelada = await prisma.solicitud.update({
            where: { idSolicitud: req.params.id },
            data: { estado: 'CANCELADA' }
        });
        res.status(200).json(cancelada);
    } catch (error) {
        if (error.code === 'P2025') return res.status(404).json({ error: "No encontrada" });
        res.status(500).json({ error: "Fallo al cancelar" });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`\n🚀 Servidor corriendo perfecto en Node 24 LTS: http://localhost:${PORT}`));