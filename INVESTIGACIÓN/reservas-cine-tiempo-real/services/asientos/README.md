# Servicio de Asientos

REST de asientos (bloqueo, liberación, confirmación) y vencimiento de bloqueos.
El contrato está en `docs/openapi-cine.yaml`.

## Puesta en marcha

1. Copiá `.env.example` a `.env` y completá `DB_PASSWORD` y `JWT_SECRET`.
2. `npm install`
3. `npm run db:init` crea `asientos_db` y carga 3 funciones (41, 42, 43) de 96 asientos cada una.
4. `npm start` (puerto 3001 por defecto).

## Comandos útiles

- `npm run token -- ana` genera un JWT de prueba para el usuario `ana`.
- `npm test` corre los tests (necesitan la base cargada).
- `npm run test:carrera` demuestra la condición de carrera y guarda la evidencia en `docs/evidencias/carrera.txt`.

## Cómo se conecta el WebSocket (Persona C)

Cada cambio de un asiento se publica en `src/eventos.js`:

    const eventos = require('./eventos');
    eventos.on('cambio', (mensaje) => { /* emitir por WebSocket a la sala mensaje.funcionId */ });

Los mensajes ya tienen el formato del contrato (`asiento_bloqueado`, `asiento_liberado`, `asiento_vendido`)
y traen `funcionId` para saber a qué sala avisar.
