const amqp = require("amqplib");

const EXCHANGE = "movilidad.eventos";
const ROUTING_KEY = "trips.trip.cancelled";
const QUEUE = "m5.trip.cancelled";
const DEAD_LETTER_QUEUE = `${QUEUE}.dlq`;

function iniciarConsumidorM6({ url, procesarEvento, logger, amqpClient = amqp, reintentoMs = 3000 }) {
  if (!url || typeof procesarEvento !== "function") {
    throw new Error("M6_RABBITMQ_URL y procesarEvento son obligatorios");
  }

  let connection = null;
  let channel = null;
  let temporizador = null;
  let detenido = false;
  let conectando = false;

  function programarReconexion() {
    if (detenido || temporizador) return;
    temporizador = setTimeout(() => {
      temporizador = null;
      void conectar();
    }, reintentoMs);
    temporizador.unref?.();
  }

  async function cerrarConexion() {
    const canalActual = channel;
    const conexionActual = connection;
    channel = null;
    connection = null;
    try { await canalActual?.close(); } catch (error) {
      logger?.warn({ err: error }, "no se pudo cerrar el canal de RabbitMQ");
    }
    try { await conexionActual?.close(); } catch (error) {
      logger?.warn({ err: error }, "no se pudo cerrar la conexión de RabbitMQ");
    }
  }

  async function procesarMensaje(canal, mensaje) {
    if (!mensaje) return;
    let evento;
    try {
      evento = JSON.parse(mensaje.content.toString("utf8"));
    } catch (error) {
      logger?.error({ err: error }, "mensaje JSON inválido recibido desde M6; se envía a la DLQ");
      canal.nack(mensaje, false, false);
      return;
    }

    try {
      await procesarEvento(evento);
      canal.ack(mensaje);
    } catch (error) {
      if (error?.noReintentar) {
        logger?.error({ err: error, eventId: evento?.eventId }, "evento M6 inválido; se envía a la DLQ");
        canal.nack(mensaje, false, false);
        return;
      }
      logger?.error({ err: error, eventId: evento?.eventId }, "falló el procesamiento de un evento M6; se reintentará");
      try { canal.nack(mensaje, false, true); } catch (nackError) {
        logger?.error({ err: nackError }, "no se pudo rechazar el evento M6");
      }
      await cerrarConexion();
      programarReconexion();
    }
  }

  async function conectar() {
    if (detenido || conectando || connection) return;
    conectando = true;
    try {
      const nuevaConexion = await amqpClient.connect(url);
      if (detenido) {
        try { await nuevaConexion.close(); } catch (error) {
          logger?.warn({ err: error }, "no se pudo cerrar una conexión RabbitMQ iniciada durante el apagado");
        }
        return;
      }
      connection = nuevaConexion;
      nuevaConexion.on("error", (error) => logger?.error({ err: error }, "error de conexión RabbitMQ de M5"));
      nuevaConexion.on("close", () => {
        if (connection === nuevaConexion) {
          connection = null;
          channel = null;
          programarReconexion();
        }
      });

      const nuevoCanal = await nuevaConexion.createChannel();
      channel = nuevoCanal;
      await nuevoCanal.assertExchange(EXCHANGE, "topic", { durable: true });
      await nuevoCanal.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
      await nuevoCanal.assertQueue(QUEUE, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": DEAD_LETTER_QUEUE,
        },
      });
      await nuevoCanal.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
      await nuevoCanal.prefetch(1);
      connection = nuevaConexion;
      channel = nuevoCanal;
      nuevoCanal.on("close", () => {
        if (channel === nuevoCanal) {
          channel = null;
          connection = null;
          void nuevaConexion.close().catch((error) => logger?.warn({ err: error }, "no se pudo cerrar la conexión de RabbitMQ"));
          programarReconexion();
        }
      });
      await nuevoCanal.consume(QUEUE, (mensaje) => procesarMensaje(nuevoCanal, mensaje), { noAck: false });
      logger?.info({ exchange: EXCHANGE, routingKey: ROUTING_KEY, queue: QUEUE }, "consumidor de cancelaciones M6 conectado");
    } catch (error) {
      logger?.error({ err: error }, "no se pudo conectar el consumidor de cancelaciones M6; se reintentará");
      await cerrarConexion();
      programarReconexion();
    } finally {
      conectando = false;
    }
  }

  const listo = conectar();
  return {
    listo,
    detener: async () => {
      detenido = true;
      if (temporizador) clearTimeout(temporizador);
      temporizador = null;
      await cerrarConexion();
    },
  };
}

module.exports = { iniciarConsumidorM6, EXCHANGE, ROUTING_KEY, QUEUE, DEAD_LETTER_QUEUE };
