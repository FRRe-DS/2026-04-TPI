require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'asientos_db',
  connectionLimit: 20,
  timezone: 'Z', // las fechas DATETIME se interpretan como UTC
});

// Cada conexión trabaja en UTC, así NOW() de la base y las fechas de Node coinciden.
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

module.exports = pool;
