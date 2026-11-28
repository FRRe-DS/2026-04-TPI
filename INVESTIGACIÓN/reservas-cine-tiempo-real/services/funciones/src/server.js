require('dotenv').config({ quiet: true });

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}

const app = require('./app');
const PORT = Number(process.env.PORT) || 3002;
app.listen(PORT, () => console.log(`Servicio de Funciones escuchando en el puerto ${PORT}`));
