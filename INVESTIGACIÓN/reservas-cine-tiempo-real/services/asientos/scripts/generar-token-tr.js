// Genera un JWT de prueba. Uso: node scripts/generar-token-tr.js usuario-123 [--vencido | --firma-invalida]
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}
const args = process.argv.slice(2);
const usuario = args.find((arg) => !arg.startsWith('--')) || 'usuario-123';
const secreto = args.includes('--firma-invalida') ? randomBytes(32) : process.env.JWT_SECRET;
const expiresIn = args.includes('--vencido') ? -60 : '8h';
console.log(jwt.sign({ sub: usuario }, secreto, { algorithm: 'HS256', expiresIn }));
