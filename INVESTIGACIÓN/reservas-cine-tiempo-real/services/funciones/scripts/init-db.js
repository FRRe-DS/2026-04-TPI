// Crea la base y carga los datos de prueba (db/schema.sql y db/seed.sql). Uso: npm run db:init
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  for (const archivo of ['schema.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', archivo), 'utf8');
    await conn.query(sql);
    console.log(`OK  ${archivo}`);
  }
  const [[r]] = await conn.query('SELECT COUNT(*) AS total FROM funciones_db.funciones');
  console.log(`Funciones cargadas: ${r.total}`);
  await conn.end();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
