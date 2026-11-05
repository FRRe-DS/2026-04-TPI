// Funciones de ofertas sobre Prisma/MySQL: es lo que el código de asignación (src/asignacion)
// recibe como `deps.ofertas` y `deps.ejecutarEnTransaccion`.
//
// REGLA QUE SOSTIENE LA ASIGNACIÓN ÚNICA: todo cambio de estado es una escritura condicional,
// `UPDATE ... WHERE estado = <el esperado>`, y se mira cuántas filas cambiaron. Nunca se lee un
// estado, se decide en JavaScript y se escribe después: entre la lectura y la escritura otro
// pedido podría haber cambiado la fila.
//
// `tx` es el cliente de la transacción abierta. Si una función que escribe usara el `prisma`
// común en vez de `tx`, esa escritura quedaría FUERA de la transacción y no se desharía.
//
// ESTADO: escrito contra la API de Prisma pero NO probado contra MySQL real (no había base
// disponible). Los tests de tests/respuesta/repositorioOfertas.test.js lo ejercitan contra un
// cliente falso que respeta los filtros; la prueba definitiva es repetirlos con docker-compose.
const { EstadoOferta } = require("../comun/estados");

function crearRepositorioOfertas(prisma, { reloj = () => new Date() } = {}) {
  const cliente = (tx) => tx ?? prisma;

  return {
    // Solo lectura: sirve para pre-validar y para explicar por qué falló una escritura.
    obtenerPorId: (ofertaId, tx) =>
      cliente(tx).oferta.findUnique({
        where: { ofertaId },
        select: { ofertaId: true, solicitudId: true, conductorId: true, estado: true, venceEn: true },
      }),

    // El WHERE ES la regla de negocio: pendiente, del conductor y vigente POR HORA.
    // (Entre que vence y que el job la marca VENCIDA pasan segundos en los que sigue
    // PENDIENTE: sin `venceEn > ahora` se podría aceptar una oferta ya vencida.)
    async aceptar({ ofertaId, conductorId, ahora }, tx) {
      const r = await cliente(tx).oferta.updateMany({
        where: { ofertaId, conductorId, estado: EstadoOferta.PENDIENTE, venceEn: { gt: ahora } },
        data: { estado: EstadoOferta.ACEPTADA, respondidaEn: ahora },
      });
      return { aceptada: r.count === 1 };
    },

    async rechazar({ ofertaId, conductorId, ahora }, tx) {
      const r = await cliente(tx).oferta.updateMany({
        where: { ofertaId, conductorId, estado: EstadoOferta.PENDIENTE, venceEn: { gt: ahora } },
        data: { estado: EstadoOferta.RECHAZADA, respondidaEn: ahora },
      });
      return { rechazada: r.count === 1 };
    },

    // Cancela las pendientes de la solicitud (menos `exceptoOfertaId`) y devuelve cuáles eran,
    // porque quien llama necesita registrar un evento y avisar a cada conductor.
    async cancelarPendientesDeSolicitud({ solicitudId, exceptoOfertaId }, tx) {
      const db = cliente(tx);
      const pendientes = await db.oferta.findMany({
        where: {
          solicitudId,
          estado: EstadoOferta.PENDIENTE,
          ...(exceptoOfertaId ? { NOT: { ofertaId: exceptoOfertaId } } : {}),
        },
        select: { ofertaId: true, conductorId: true },
      });
      if (pendientes.length === 0) return [];
      await db.oferta.updateMany({
        where: { ofertaId: { in: pendientes.map((p) => p.ofertaId) }, estado: EstadoOferta.PENDIENTE },
        data: { estado: EstadoOferta.CANCELADA },
      });
      return pendientes;
    },

    // Solo cuenta las VIGENTES: una oferta vencida por hora que el job todavía no marcó no
    // puede aceptarse, así que no debe impedir que la búsqueda se considere agotada.
    contarPendientes: (solicitudId, tx) =>
      cliente(tx).oferta.count({
        where: { solicitudId, estado: EstadoOferta.PENDIENTE, venceEn: { gt: reloj() } },
      }),

    // ── Para el job de vencimientos ──
    listarVencidas: ({ ahora, lote = 100 }, tx) =>
      cliente(tx).oferta.findMany({
        where: { estado: EstadoOferta.PENDIENTE, venceEn: { lte: ahora } },
        orderBy: { venceEn: "asc" },
        take: lote,
        select: { ofertaId: true, solicitudId: true, conductorId: true },
      }),

    async vencer({ ofertaId, ahora }, tx) {
      const r = await cliente(tx).oferta.updateMany({
        where: { ofertaId, estado: EstadoOferta.PENDIENTE, venceEn: { lte: ahora } },
        data: { estado: EstadoOferta.VENCIDA },
      });
      return { vencida: r.count === 1 };
    },
  };
}

// ejecutarEnTransaccion(fn): confirma si fn termina y deshace si lanza. Si MySQL aborta por
// deadlock, Prisma lanza P2034, que conReintentoPorDeadlock (src/asignacion) ya reintenta.
function crearEjecutarEnTransaccion(prisma, { maxWaitMs = 2000, timeoutMs = 5000 } = {}) {
  return (fn) => prisma.$transaction(fn, { maxWait: maxWaitMs, timeout: timeoutMs });
}

module.exports = { crearRepositorioOfertas, crearEjecutarEnTransaccion };
