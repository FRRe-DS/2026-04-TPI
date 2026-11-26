# Análisis de cambios de M5

## Alcance

Este documento resume los cambios de integración trabajados dentro de M5 y explica su motivo y objetivo. No se creó un commit de Git: el archivo resume cambios locales. Además, varios archivos ya tenían modificaciones locales antes de esta tarea; por eso este informe no atribuye automáticamente todo el diff actual a este trabajo. No se modificaron archivos de otros módulos.

## Cambios realizados

### Búsqueda con M4

- M5 solicita `limite=100`, el máximo permitido por el contrato de M4.
- Las búsquedas y las tandas filtran candidatos por ronda.

**Por qué y para qué:** poder guardar y procesar listas de candidatos separadas cuando una cancelación de M6 requiere redespachar, sin mezclar candidatos de intentos distintos. M4 no documenta cursor ni paginación, así que el límite de 100 sigue siendo una restricción.

### Cancelaciones y redespacho con M6

- Se incorporó el consumidor RabbitMQ de `TripCancelled`, con exchange `movilidad.eventos`, routing key `trips.trip.cancelled` y cola durable `m5.trip.cancelled`.
- Se agregó una cola de mensajes no procesables (DLQ), reconexión ante caídas del broker y confirmación de mensajes procesados.
- M5 valida y deduplica eventos por `eventId`; si el mismo ID llega con contenido distinto, lo trata como error.
- Si el evento requiere redespacho, M5 persiste un nuevo `requestIdM6`, incrementa el intento y reinicia la búsqueda. Si no lo requiere, cierra la solicitud como cancelada.
- Se guarda el identificador de viaje devuelto por M6.

**Por qué y para qué:** completar el ciclo posterior a la asignación y permitir que M5 recupere la búsqueda ante ciertas cancelaciones, de forma segura frente a entregas repetidas o reinicios.

### Notificaciones a M8

- Se implementó un outbox persistente para los eventos `VIAJE_SOLICITADO` y `VIAJE_ASIGNADO`.
- Los eventos se encolan después de que M6 devuelve el `viajeId` real y se envían en ese orden.
- Los reintentos conservan el mismo `eventoId` y cuerpo; se consideran errores transitorios, se respeta `Retry-After` y se limita la cantidad de intentos.
- M5 incluye el contacto del cliente cuando está disponible y el `conductorId` en el detalle de asignación, requerido por la implementación de M8.

**Por qué y para qué:** no perder los avisos si M8 está temporalmente indisponible y evitar que el envío de notificaciones bloquee o revierta la asignación.

### Persistencia y configuración

- Se agregaron a los esquemas Prisma campos para email, identificador M6 por intento, número de intento, viaje y ronda.
- Se añadieron los modelos `EventoM6Procesado` y `NotificacionM8` para deduplicar cancelaciones y guardar la cola de salida.
- Se actualizó `prisma/modelos-m5.prisma` como referencia complementaria de los modelos añadidos.
- Se incorporó `amqplib` para RabbitMQ y variables de configuración para el consumidor M6 y la conexión M8.
- El cliente HTTP conserva el valor `Retry-After` para programar reintentos.

**Por qué y para qué:** mantener el estado de integración entre reinicios, generar IDs idempotentes por intento y evitar depender de datos volátiles en memoria.

> El cliente Prisma se generó correctamente. No se ejecutó `db:push`; antes de usar estos cambios contra una base real hay que aplicar el esquema correspondiente.

### Documentación

- Se actualizaron `integracion.md` y `docs/openapi-a.yml` para reflejar los contratos y flujos vigentes de M4, M6, M8 y M9.
- Se documentaron las discrepancias que M5 no puede corregir desde su propio módulo.

## Verificación

- Pasaron las 25 pruebas enfocadas de búsqueda M4, cliente HTTP, consumidor/procesador M6 y outbox M8.
- El YAML de `docs/openapi-a.yml` se parseó correctamente y declara OpenAPI 3.1.
- No se verificó la comunicación contra instancias reales de M6, M8, M9 ni RabbitMQ.
- La suite completa tiene una limitación conocida: una prueba preexistente importa `axios`, dependencia que no está instalada.

## Pendientes y discrepancias

1. **M9:** el callback recibe reintentos HTTP limitados, pero no existe outbox durable que lo recupere tras agotar los intentos o reiniciar M5. Se revisó y se dejó sin cambios.
2. **M8:** su implementación exige `detalle.conductorId` en `VIAJE_ASIGNADO`, pero el OpenAPI publicado no lo documenta y restringe propiedades adicionales. M5 lo envía para ajustarse al handler; M8 debe alinear su contrato.
3. **M9/M8:** M5 acepta `cliente_email` opcional para notificaciones, pero M9 todavía no lo envía al activar una reserva.
4. **M3:** M5 persiste el vehículo asignado, pero al repetir el procesamiento vuelve a consultar M3 en vez de reutilizar siempre el valor guardado. Si M3 devuelve otro vehículo, M6 puede recibir datos distintos para el mismo `requestId`.
5. **M4:** no hay paginación documentada para superar los 100 candidatos; M5 procesa en tandas la lista recibida y no consulta otra lista al agotarla.

## Archivos principales

- `src/integraciones/m6Cancelaciones.js` y `src/integraciones/m6Consumer.js`: validación, deduplicación, redespacho y consumo RabbitMQ.
- `src/integraciones/m8Outbox.js`: persistencia, orden y reintentos de eventos M8.
- `src/main.js` y `src/asignacion/notificaciones.js`: conexión de los flujos y almacenamiento de IDs de viaje/intento.
- `bd/prisma/schema.prisma` y `prisma/modelos-m5.prisma`: campos y modelos persistentes.
- `tests/integraciones/`: pruebas del consumidor/procesador M6 y del outbox M8.
- `integracion.md` y `docs/openapi-a.yml`: estado de integración y contratos documentados.

## Cambios documentados en `docs/openapi-a.yml`

Se actualizaron las descripciones y esquemas de integración de M5 para que reflejen el comportamiento implementado:

- **M4:** se documentó que M5 solicita `limite=100`, el máximo del contrato, y que M4 no ofrece paginación documentada para recuperar candidatos adicionales.
- **M6:** se precisó que `requestId` es único por intento, con un identificador nuevo al redespachar. Se actualizaron el exchange, routing key y colas RabbitMQ de `TripCancelled`, y el esquema ahora representa el sobre del evento con los datos dentro de `payload`.
- **M8:** el esquema de solicitud se ajustó a los tipos publicados que M5 realmente envía (`VIAJE_SOLICITADO` y `VIAJE_ASIGNADO`) y a que ambos requieren el `viajeId` real. También se anotó que `detalle.conductorId` lo exige la implementación de M8 aunque no figure en su OpenAPI publicado.
- **M9:** se documentó `cliente_email` como campo opcional que M5 acepta para notificaciones, aunque M9 aún no lo envía. También se aclaró que el callback de resultado tiene reintentos HTTP limitados, pero no una cola durable para recuperarlo tras fallos o reinicios.
- **Flujo general:** se reemplazó el estado anterior de “pendiente/no implementado” para M6 y M8 por los flujos que ya existen en M5.

Estos cambios describen el contrato y comportamiento de M5; no modifican los contratos ni el código de M4, M6, M8 o M9. El archivo OpenAPI ya tenía cambios locales previos, por lo que este apartado resume los ajustes de integración relevantes y no atribuye todo su diff a esta tarea.
