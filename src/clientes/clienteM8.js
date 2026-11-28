// src/clientes/clienteM8.js
async function informarEventoM8(clienteM8, evento) {
  if (!clienteM8 || typeof clienteM8.post !== "function") {
    throw new Error("Se requiere un cliente M8 válido.");
  }
  if (!evento || !evento.eventoId) {
    throw new Error("El evento debe incluir un eventoId válido para garantizar idempotencia.");
  }

  // POST /api/v1/eventos con idempotency-key = eventoId (contrato M8 / RNF-09)
  return await clienteM8.post("/api/v1/eventos", evento, {
    claveIdempotencia: evento.eventoId,
  });
}

module.exports = { informarEventoM8 };
