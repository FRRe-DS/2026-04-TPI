const { EventEmitter } = require("node:events");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  iniciarConsumidorM6,
  EXCHANGE,
  ROUTING_KEY,
  QUEUE,
  DEAD_LETTER_QUEUE,
} = require("../../src/integraciones/m6Consumer");

function clienteAmqpFalso() {
  const canal = new EventEmitter();
  const conexion = new EventEmitter();
  const acciones = { ack: [], nack: [], bindings: [], queues: [], exchanges: [] };
  canal.assertExchange = async (...args) => acciones.exchanges.push(args);
  canal.assertQueue = async (...args) => acciones.queues.push(args);
  canal.bindQueue = async (...args) => acciones.bindings.push(args);
  canal.prefetch = async (count) => { acciones.prefetch = count; };
  canal.consume = async (_queue, callback, options) => { canal.callback = callback; acciones.consumeOptions = options; };
  canal.ack = (mensaje) => acciones.ack.push(mensaje);
  canal.nack = (...args) => acciones.nack.push(args);
  canal.close = async () => canal.emit("close");
  conexion.createChannel = async () => canal;
  conexion.close = async () => conexion.emit("close");
  return {
    acciones,
    canal,
    connect: async () => conexion,
  };
}

describe("consumidor RabbitMQ de cancelaciones M6", () => {
  test("declara exchange topic durable, cola durable y binding del contrato", async () => {
    const amqpFalso = clienteAmqpFalso();
    const consumidor = iniciarConsumidorM6({
      url: "amqp://test",
      procesarEvento: async () => {},
      amqpClient: amqpFalso,
    });
    await consumidor.listo;

    assert.deepEqual(amqpFalso.acciones.exchanges[0], [EXCHANGE, "topic", { durable: true }]);
    assert.ok(amqpFalso.acciones.queues.some(([nombre, opciones]) =>
      nombre === QUEUE && opciones.durable && opciones.arguments["x-dead-letter-routing-key"] === DEAD_LETTER_QUEUE
    ));
    assert.deepEqual(amqpFalso.acciones.bindings[0], [QUEUE, EXCHANGE, ROUTING_KEY]);
    assert.equal(amqpFalso.acciones.prefetch, 1);
    await consumidor.detener();
  });

  test("confirma eventos procesados y envía JSON inválido a la DLQ", async () => {
    const amqpFalso = clienteAmqpFalso();
    const eventos = [];
    const consumidor = iniciarConsumidorM6({
      url: "amqp://test",
      procesarEvento: async (evento) => eventos.push(evento),
      amqpClient: amqpFalso,
      logger: { error() {} },
    });
    await consumidor.listo;

    const valido = { content: Buffer.from('{"eventType":"TripCancelled"}') };
    await amqpFalso.canal.callback(valido);
    assert.deepEqual(eventos, [{ eventType: "TripCancelled" }]);
    assert.deepEqual(amqpFalso.acciones.ack, [valido]);

    const invalido = { content: Buffer.from("{") };
    await amqpFalso.canal.callback(invalido);
    assert.deepEqual(amqpFalso.acciones.nack, [[invalido, false, false]]);
    await consumidor.detener();
  });
});
