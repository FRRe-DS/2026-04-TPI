// Demuestra la condición de carrera: 10 usuarios intentan bloquear el MISMO asiento a la vez.
//   - Versión ingenua (leer y después escribir): varios "ganan" => doble asignación.
//   - Versión condicionada (un solo UPDATE):     gana exactamente uno.
// Uso: npm run test:carrera   (guarda el resultado en docs/evidencias/carrera.txt)
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');
const { bloquearAsiento } = require('../src/bloqueo');

const USUARIOS = 10;

async function idAsiento() {
  const [[a]] = await pool.execute(
    "SELECT id FROM asientos WHERE funcion_id = 42 AND fila = 'F' AND numero = 5"
  );
  return a.id;
}

async function resetear(id) {
  await pool.execute(
    "UPDATE asientos SET estado='libre', bloqueado_por=NULL, bloqueado_hasta=NULL WHERE id = ?", [id]);
}

// MAL HECHO a propósito: lee el estado, y recién después escribe. La pausa hace visible la carrera.
async function bloquearIngenuo(id, usuario) {
  const [[a]] = await pool.execute('SELECT estado FROM asientos WHERE id = ?', [id]);
  if (a.estado !== 'libre') return false;
  await new Promise((r) => setTimeout(r, 100));
  await pool.execute(
    "UPDATE asientos SET estado='bloqueado', bloqueado_por=?, bloqueado_hasta=DATE_ADD(NOW(), INTERVAL 60 SECOND) WHERE id = ?",
    [usuario, id]
  );
  return true;
}

async function correr(titulo, fn, id) {
  await resetear(id);
  const resultados = await Promise.all(
    Array.from({ length: USUARIOS }, (_, i) => fn(id, `usuario-${i}`))
  );
  const exitos = resultados.filter(Boolean).length;
  return `${titulo}: ${exitos} éxitos de ${USUARIOS} intentos simultáneos`;
}

(async () => {
  const id = await idAsiento();
  const lineas = [
    `Prueba de condición de carrera - ${new Date().toISOString()}`,
    `Asiento F5 de la función 42 (id ${id}), ${USUARIOS} usuarios a la vez`,
    '',
    await correr('Ingenua (leer y después escribir)', bloquearIngenuo, id) + '   <- MAL: varios creen que lo ganaron',
    await correr('Condicionada (un solo UPDATE)   ', bloquearAsiento, id) + '   <- BIEN: gana exactamente uno',
  ];
  await resetear(id);
  const salida = lineas.join('\n');
  console.log(salida);

  const carpeta = path.join(__dirname, '..', '..', '..', 'docs', 'evidencias');
  fs.mkdirSync(carpeta, { recursive: true });
  fs.appendFileSync(path.join(carpeta, 'carrera.txt'), salida + '\n\n');
  await pool.end();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
