// Utilidades de transacción para la asignación única (RNF-08).

// Se lanza DENTRO de la transacción para deshacerla cuando el resultado de negocio
// es "perdiste" (otro ganó, cancelaron, venció la oferta). No es un error técnico.
class RevertirTransaccion extends Error {
  constructor(resultado) {
    super(`Transacción revertida: ${resultado}`);
    this.name = "RevertirTransaccion";
    this.resultado = resultado;
  }
}

// P2034: Prisma ("write conflict or deadlock"). ER_LOCK_DEADLOCK / errno 1213: MySQL.
const CODIGOS_DEADLOCK = new Set(["P2034", "ER_LOCK_DEADLOCK"]);

function esDeadlock(error) {
  return Boolean(error) && (CODIGOS_DEADLOCK.has(error.code) || error.errno === 1213);
}

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Reintenta la transacción completa si MySQL la abortó por deadlock.
async function conReintentoPorDeadlock(fn, { maxIntentos = 3, esperaMs = 20 } = {}) {
  let intento = 0;
  for (;;) {
    intento += 1;
    try {
      return await fn();
    } catch (error) {
      if (!esDeadlock(error) || intento >= maxIntentos) throw error;
      await dormir(esperaMs * intento + Math.floor(Math.random() * esperaMs));
    }
  }
}

function conTimeout(promesa, ms, mensaje = "timeout") {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(mensaje)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

module.exports = { RevertirTransaccion, esDeadlock, conReintentoPorDeadlock, conTimeout };
