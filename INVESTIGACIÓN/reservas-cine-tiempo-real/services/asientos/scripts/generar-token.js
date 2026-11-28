// Genera un JWT de prueba. Uso: npm run token -- usuario-123
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}
const usuario = process.argv[2] || 'usuario-123';
console.log(jwt.sign({ sub: usuario }, process.env.JWT_SECRET, { expiresIn: '8h' }));
