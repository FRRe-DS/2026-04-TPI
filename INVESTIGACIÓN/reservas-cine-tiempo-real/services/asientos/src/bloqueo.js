// Lógica de asientos. Acá está lo importante del tema de concurrencia:
// cada cambio de estado es UN SOLO UPDATE con la condición en el WHERE.
// La base de datos decide quién gana, de forma atómica: no hay "leer y después escribir".
const pool = require('./db');

const SEGUNDOS_BLOQUEO = Number(process.env.SEGUNDOS_BLOQUEO) || 60;

// "vencido" = está marcado como bloqueado pero su bloqueo ya expiró (se trata como libre)
const COLUMNAS = `id, funcion_id, fila, numero, estado, bloqueado_por, bloqueado_hasta, version,
                  (estado = 'bloqueado' AND bloqueado_hasta <= NOW()) AS vencido`;

function aAsiento(r) {
  const base = { id: r.id, funcionId: r.funcion_id, fila: r.fila, numero: r.numero, version: r.version };
  if (r.vencido) {
    return { ...base, estado: 'libre', bloqueadoPor: null, bloqueadoHasta: null };
  }
  return {
    ...base,
    estado: r.estado,
    bloqueadoPor: r.bloqueado_por,
    bloqueadoHasta: r.bloqueado_hasta ? r.bloqueado_hasta.toISOString() : null,
  };
}

async function obtenerAsiento(id) {
  const [filas] = await pool.execute(`SELECT ${COLUMNAS} FROM asientos WHERE id = ?`, [id]);
  return filas.length ? aAsiento(filas[0]) : null;
}

async function obtenerGrilla(funcionId) {
  const [filas] = await pool.execute(
    `SELECT ${COLUMNAS} FROM asientos WHERE funcion_id = ? ORDER BY fila, numero`,
    [funcionId]
  );
  return filas.map(aAsiento);
}

// Pasa a "bloqueado" solo si está libre, o si su bloqueo anterior ya venció.
// Devuelve true si lo ganó este usuario (1 fila afectada) y false si no.
async function bloquearAsiento(asientoId, usuarioId) {
  const [res] = await pool.execute(
    `UPDATE asientos
        SET estado = 'bloqueado',
            bloqueado_por = ?,
            bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? SECOND),
            version = version + 1
      WHERE id = ?
        AND (estado = 'libre'
             OR (estado = 'bloqueado' AND bloqueado_hasta <= NOW()))`,
    [usuarioId, SEGUNDOS_BLOQUEO, asientoId]
  );
  return res.affectedRows === 1;
}

// Libera un bloqueo propio.
async function liberarAsiento(asientoId, usuarioId) {
  const [res] = await pool.execute(
    `UPDATE asientos
        SET estado = 'libre', bloqueado_por = NULL, bloqueado_hasta = NULL, version = version + 1
      WHERE id = ? AND estado = 'bloqueado' AND bloqueado_por = ?`,
    [asientoId, usuarioId]
  );
  return res.affectedRows === 1;
}

// Confirma la compra: solo si el bloqueo es del usuario y todavía no venció.
async function confirmarAsiento(asientoId, usuarioId) {
  const [res] = await pool.execute(
    `UPDATE asientos
        SET estado = 'vendido', bloqueado_hasta = NULL, version = version + 1
      WHERE id = ? AND estado = 'bloqueado' AND bloqueado_por = ? AND bloqueado_hasta > NOW()`,
    [asientoId, usuarioId]
  );
  return res.affectedRows === 1;
}

// Libera los bloqueos vencidos. Devuelve los asientos liberados para poder avisar por WebSocket.
// Cada asiento se libera con su propio UPDATE condicionado, así no pisa a alguien que
// justo volvió a bloquearlo entre el SELECT y el UPDATE.
async function liberarVencidos() {
  const [vencidos] = await pool.execute(
    `SELECT id, funcion_id, fila, numero, version
       FROM asientos WHERE estado = 'bloqueado' AND bloqueado_hasta <= NOW()`
  );
  const liberados = [];
  for (const a of vencidos) {
    const [res] = await pool.execute(
      `UPDATE asientos
          SET estado = 'libre', bloqueado_por = NULL, bloqueado_hasta = NULL, version = version + 1
        WHERE id = ? AND estado = 'bloqueado' AND bloqueado_hasta <= NOW()`,
      [a.id]
    );
    if (res.affectedRows === 1) {
      liberados.push({ id: a.id, funcionId: a.funcion_id, fila: a.fila, numero: a.numero, version: a.version + 1 });
    }
  }
  return liberados;
}

module.exports = {
  obtenerAsiento,
  obtenerGrilla,
  bloquearAsiento,
  liberarAsiento,
  confirmarAsiento,
  liberarVencidos,
};
