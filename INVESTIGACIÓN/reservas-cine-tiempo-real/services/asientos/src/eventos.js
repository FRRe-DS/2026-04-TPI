// Bus de eventos interno del servicio.
// La parte de REST (Persona B) publica acá cada cambio de un asiento y el servidor
// WebSocket (Persona C) se suscribe:  eventos.on('cambio', (mensaje) => ...)
//
// Cada mensaje ya tiene el formato de los mensajes WebSocket del contrato (docs/openapi-cine.yaml),
// más `funcionId`, que el servidor WebSocket necesita para saber a qué sala avisar.
const { EventEmitter } = require('events');

const eventos = new EventEmitter();

const base = (a) => ({ funcionId: a.funcionId, asientoId: a.id, fila: a.fila, numero: a.numero, version: a.version });

eventos.mensajes = {
  bloqueado: (a) => ({ tipo: 'asiento_bloqueado', ...base(a), bloqueadoHasta: a.bloqueadoHasta }),
  liberado: (a, motivo) => ({ tipo: 'asiento_liberado', ...base(a), motivo }), // 'liberado_por_usuario' | 'bloqueo_vencido'
  vendido: (a) => ({ tipo: 'asiento_vendido', ...base(a) }),
};

eventos.publicar = (mensaje) => eventos.emit('cambio', mensaje);

module.exports = eventos;
