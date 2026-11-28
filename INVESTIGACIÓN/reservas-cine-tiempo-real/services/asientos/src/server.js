require('dotenv').config({ quiet: true });

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}

const app = require('./app');
const asientos = require('./bloqueo');
const eventos = require('./eventos');

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => console.log(`Servicio de Asientos escuchando en el puerto ${PORT}`));

// Vencimiento de bloqueos: cada pocos segundos libera los vencidos y avisa del cambio.
const INTERVALO = Number(process.env.INTERVALO_VENCIMIENTO_MS) || 5000;
setInterval(async () => {
  try {
    for (const a of await asientos.liberarVencidos()) {
      eventos.publicar(eventos.mensajes.liberado(a, 'bloqueo_vencido'));
    }
  } catch (e) {
    console.error('Error al liberar bloqueos vencidos:', e.message);
  }
}, INTERVALO);

// Mientras no esté el servidor WebSocket (Persona C), los cambios se ven en la consola.
eventos.on('cambio', (mensaje) => console.log('[evento]', JSON.stringify(mensaje)));
