# Integraciones de M5: estado, realizado y pendiente

**Revisión:** 26 de noviembre de 2026  
**Alcance:** únicamente las llamadas y los mensajes entre M5 y los módulos que M5 consume. No evalúa integraciones entre otros módulos.  
**Nota:** “implementado” describe código/contrato de M5, no una prueba con servicios desplegados. Los valores reales de URLs, tokens y secretos deben configurarse en el entorno de ejecución.

## Resumen ejecutivo

| Módulo | Hecho en M5 | Estado actual y pendiente |
|---|---|---|
| M1 / Keycloak | M5 valida JWT y puede obtener tokens M2M para sus llamadas de servicio. | Falta comprobar configuración de roles, scopes, emisor y secretos en el entorno real. |
| M2 | M5 consulta el estado de cuenta antes de crear/activar una solicitud. | Contrato revisado; falta configurar el modo/token y probar conectividad real. |
| M3 | M5 envía ofertas y consulta los datos de despacho del conductor ganador. | En una repetición todavía vuelve a consultar el vehículo en M3 en vez de reutilizar el guardado en M5. |
| M4 | M5 consulta, ordena y procesa candidatos por tandas; solicita hasta 100. | No hay paginación documentada para superar ese límite; falta validar reservas/liberaciones con M4 real. |
| M6 | M5 crea viajes y consume eventos de cancelación; maneja redespacho con otro `requestId`. | Código y pruebas enfocados listos; falta probar con M6 y RabbitMQ desplegados. |
| M7 | M5 solicita estimaciones de tarifa usando ruta y unidades acordadas. | Falta prueba integrada; la validación del scope `tarifas:read` no coincide con la implementación M7 revisada. |
| M8 | M5 persiste y reintenta los eventos de viaje admitidos por M8. | Falta prueba integrada y alinear `detalle.conductorId` con el contrato publicado; eventos agotados quedan `FALLIDA`. |
| M9 | M5 acepta activaciones de reserva y envía resultados de despacho. | Callback con reintentos HTTP limitados, pero sin recuperación durable; M9 no envía el email opcional. |

## Detalle por integración

### M1 / Keycloak — autenticación — **parcial**

- M5 valida identidad/autorización mediante JWT y usa tokens de servicio para llamadas entre módulos.
- La configuración local de ejemplo deja vacías credenciales como `M2_TOKEN`, `M3_TOKEN`, `M4_TOKEN`, `M6_TOKEN` y `M7_TOKEN`; el despliegue debe suministrar tokens válidos con los roles/scopes que exige cada servicio.
- El token interno de M5 y las rutas de servicio tienen mecanismos de autorización propios. Hay que mantener coherentes la configuración de Keycloak y las políticas de cada módulo.
- **Pendiente:** comprobar los roles/scopes efectivos de cada cliente de servicio y definir cómo se renuevan/rotan los tokens. La presencia de un realm compartido no confirma por sí sola que las credenciales desplegadas sean válidas.

### M2 — estado de cuenta del cliente — **implementado en M5; falta validación real**

- M5 consulta `GET /api/v1/clientes/{clienteId}/estado-cuenta` antes de crear/activar solicitudes.
- La implementación del Grupo 17 deriva permisos del contrato compartido. El endpoint admite `CLIENTE`, `OPERADOR` o `SERVICIO`; en modo `jwks` exige además el scope `clientes.estado:read`. La respuesta incluye `estado` y `bloqueosVigentes`; M5 solo permite continuar si `estado` es `ACTIVO`. Si el perfil no existe (404), M5 devuelve el error de cliente sin perfil.
- La imagen/compose del Grupo 17 publica M2 en el puerto `8082` por defecto. Desde el backend M5 ejecutado en la misma computadora, usar `M2_URL=http://localhost:8082`. Si M5 corre dentro de otro contenedor, `localhost` no apunta al host ni al contenedor M2: ambos deben compartir una red Docker y M5 debe usar el nombre DNS del servicio M2, por ejemplo `http://m2:8082`.
- `.env.example` de M5 estaba configurado con el puerto `3002`, que no coincide con el puerto publicado por M2. Se corrigió a `8082`; al usar un `.env` local ya creado, actualizarlo también.
- **Token de desarrollo sencillo:** el `ejemplo.env` de M2 arranca en `M2_MODO_TOKENS=hs256`. En ese modo se puede generar un token compatible directamente desde el contenedor M2 (no hace falta copiar un access token de Keycloak):

  ```bash
  docker compose exec -T m2 node dist/herramientas/token.js --sub m5-solicitudes --roles SERVICIO
  ```

  Copiar la salida completa en `M2_TOKEN` del entorno del backend M5. El `sub` identifica al servicio llamante y puede ser `m5-solicitudes`. M2 y M5 deben estar usando los mismos valores de desarrollo de emisor, audiencia y clave que trae `ejemplo.env`; M5 envía el token como `Authorization: Bearer ...`. El token generado dura una hora por defecto. Reiniciar M5 después de editar su `.env`.
- Si M2 se levanta con `ejemplo-keycloak.env` (`M2_MODO_TOKENS=jwks`), el token HS256 anterior no sirve. En ese modo `M2_TOKEN` debe ser un JWT RS256 emitido por el Keycloak configurado para M2, con rol `SERVICIO` y scope `clientes.estado:read`; un token inventado o emitido por otro realm no valida. El realm de M2 Grupo 17 y la lista de roles `*-be` del Keycloak de M5 no deben asumirse compatibles: hay que comprobar emisor, claim de roles y scope en la configuración real.
- **Pendiente:** definir qué modo de tokens usar en el entorno compartido y verificar URL, token y respuesta con M2 y M5 en ejecución. No se verificó conectividad durante esta revisión.

### M3 — ofertas y datos del conductor — **integrado; queda un problema de repetición**

- M5 envía las ofertas individualmente a `POST /api/v1/integration/m5/offers`, con los campos camelCase del contrato vigente de M3. M3 responde con aceptación HTTP 202 y contempla deduplicación por oferta.
- M5 recibe la respuesta del conductor en `POST /api/v1/offers/{offerId}/driver-response`, valida `Idempotency-Key` y adapta la respuesta al formato esperado por M3 (`status`, `tripId`).
- Antes de asignar, M5 consulta `POST /api/v1/integration/drivers/dispatch-info` con `{ conductor_id }`. Usa los indicadores `habilitado` y `disponible`, además del `vehiculo_id` y `tipo_vehiculo` devueltos.
- El identificador de vehículo se envía luego a M6 como `vehicleId`. M5 lo persiste al completar la asignación.
- **Pendiente:** al procesar una repetición, M5 vuelve a consultar M3 en vez de reutilizar el `vehiculo_id` persistido. Si el valor cambia, M6 puede recibir datos distintos con el mismo `requestId` y responder conflicto. Este punto queda pendiente dentro de M5.

### M4 — búsqueda, estimación de ruta y reservas — **implementación M5 parcial**

- Para buscar conductores, M5 consulta `GET /api/v1/conductores/cercanos` con origen y tipo de vehículo. Mapea `conductores[]`, `conductor_id`, `distancia_origen_km`, `eta_retiro_minutos` y `tipo_vehiculo`.
- Las distancias se mantienen en **kilómetros**; M5 no las convierte a metros. M5 solicita `limite=100`, el máximo del contrato de M4, y ordena los candidatos por distancia antes de abrir las tandas.
- M5 reserva y libera con `POST /api/v1/conductores/{conductor_id}/reserva`, enviando `estado_temporal` (`RESERVADO` o `LIBERADO`) y `solicitud_id`, junto con una clave de idempotencia.
- Para estimar la ruta, M5 usa `GET /api/v1/rutas/estimacion` y consume `distancia_estimada_km` y `eta_minutos`.
- **Hecho en M5:** consulta hasta 100 candidatos, los ordena y los ofrece por tandas; reserva cada conductor antes de enviarle la oferta y pasa al siguiente ante un `409`.
- **Pendiente del contrato/comportamiento M4:** no se documenta paginación para superar 100 candidatos. Además, hay que comprobar con M4 real que liberar y volver a reservar sea consistente y que la reserva de un conductor sea atómica ante solicitudes concurrentes.
- **Pendiente en M5:** al agotar la lista de una búsqueda, M5 no vuelve a pedir candidatos a M4. Por eso puede no alcanzar conductores que quedaron fuera del límite.

### M6 — creación y cancelación del viaje — **implementado en M5; falta prueba integrada**

- M5 crea viajes en `POST /trips` con un `requestIdM6` aleatorio y persistido por intento. Cada redespacho genera otro identificador. Envía cliente, conductor, vehículo, tipo y coordenadas; la respuesta `id` de M6 se guarda como `tripId`.
- La forma de la solicitud inicial coincide con el OpenAPI revisado. M6 aplica idempotencia de dominio usando `requestId`: repetirlo con datos distintos puede devolver `409`. M5 reintenta con el mismo cuerpo y la misma clave cuando corresponde.
- M6 acepta `SYSTEM` y sus alias de servicio, incluido `SERVICIO`, según su contrato. M5 envía `M6_TOKEN` como Bearer; el token debe provenir del emisor que M6 confía.
- M5 consume `TripCancelled` desde el exchange durable `movilidad.eventos`, routing key `trips.trip.cancelled`, mediante la cola durable `m5.trip.cancelled`; los mensajes inválidos se envían a `m5.trip.cancelled.dlq`.
- El consumidor deduplica por `eventId`. Si `requiresRedispatch=true`, M5 crea y persiste un nuevo `requestId` M6 por intento, incrementa la ronda y reanuda la búsqueda; si es `false`, cierra la solicitud como cancelada. El procesamiento es transaccional e idempotente.
- **Pendiente de verificación:** conexión con el broker/M6 desplegados y comportamiento ante errores reales de entrega y reinicios.

### M7 — cálculo de tarifa — **llamada implementada; autenticación por confirmar**

- M5 estima la ruta con M4 y envía a M7 `POST /api/v1/tarifas/estimaciones` con `tipo_vehiculo`, `distancia_km` y `duracion_estimada_min`.
- Los nombres y unidades coinciden con el contrato compartido; M5 conserva kilómetros, redondea la duración hacia arriba a minutos enteros y lee `moneda` y `desglose.total`.
- **Discrepancia M5–M7:** el contrato común exige OAuth scope `tarifas:read`, pero la implementación actual de M7 revisada no contiene validación de JWT/scopes. M5 adjunta `M7_TOKEN` si se configura, pero M7 no lo valida en el código inspeccionado. M7 debe resolver esa diferencia; configurar el token en M5 no la soluciona.

### M8 — notificaciones — **outbox implementado; contrato por alinear**

- Si `M8_URL` está configurada, M5 guarda los eventos en su outbox de base de datos y los envía a `POST /api/v1/eventos` sin bloquear el despacho. Conserva el mismo `eventoId` y cuerpo al reintentar; aplica hasta ocho intentos para errores transitorios y respeta `Retry-After`.
- Después de crear el viaje en M6, M5 envía en orden `VIAJE_SOLICITADO` y `VIAJE_ASIGNADO`, ambos con el `viajeId` real. No envía eventos previos al viaje ni `SOLICITUD_CANCELADA`/`BUSQUEDA_SIN_CONDUCTOR`, que no están en el enum publicado por M8.
- **Discrepancia M5–M8:** el handler de M8 exige `detalle.conductorId` para `VIAJE_ASIGNADO`, pero el OpenAPI publicado no lo define y restringe propiedades adicionales. M5 lo incluye para satisfacer la implementación; M8 debe alinear/publicar el contrato. No se modificó M8.
- **Discrepancia M5–M9–M8:** M5 acepta `cliente_email` opcional para entregar el contacto a M8, pero M9 todavía no lo envía al activar una reserva. En ese caso M8 podría no tener un contacto utilizable.
- **Pendiente operativo:** después de agotar los ocho intentos el evento queda `FALLIDA`; no se reintenta automáticamente. Se necesita resolver el contrato y acordar cómo inspeccionar/reprocesar esos eventos.

### M9 — reservas — **activación y callback implementados; callback no durable**

- M9 activa una reserva con `POST {M5_DESPACHO_URL}/solicitudes/desde-reserva`. M5 recibe `reserva_id`, `cliente_id`, `origen_latitud`, `origen_longitud`, `destino_latitud`, `destino_longitud`, `tipo_vehiculo` y `tarifa_estimada: { moneda, total_estimado }`. M5 valida al cliente en M2, registra la solicitud e inicia el despacho. Devuelve `reserva_id`, `solicitud_id` y `estado`.
- M5 acepta también `cliente_email` opcional en la activación para incluirlo como contacto en los eventos M8. M9 aún no lo envía.
- **Autenticación M9 → M5:** M9 obtiene y cachea el token M2M con Keycloak `client_credentials`. M5 valida RS256 y emisor de Keycloak, y acepta `SERVICIO` o `reservas-be`; no requiere scopes. El cliente de servicio configurado para M9 debe tener el rol `reservas-be` o `SERVICIO` incluido en `realm_access.roles`. El fallback HS256 de M9 no es válido para M5.
- Cuando la solicitud de reserva termina en `asignada`, M5 notifica `CONFIRMADA`; si termina en `sin_disponibilidad`, notifica `VENCIDA`. Envía `POST {M9_URL}/reservas/{reserva_id}/despacho` con `{ "solicitud_id": "…", "resultado": "CONFIRMADA" | "VENCIDA", "fecha": "<ISO 8601>" }` y una clave idempotente. M5 tiene reintentos HTTP limitados; si se agotan, el fallo se registra como aviso fallido, pero el callback no queda en una cola durable ni se recupera después de reiniciar M5.
- **Pendiente confirmado (punto 2):** el cliente HTTP está configurado con dos reintentos (hasta tres intentos por llamada), pero el callback no se guarda en una cola durable. Si todos fallan, se registra el error y no hay recuperación automática tras un reinicio. Esto se revisó y se deja sin cambios en el alcance actual.
- **Autenticación M5 → M9:** M5 obtiene automáticamente un token M2M de Keycloak y lo cachea. Puede usar `M5_SERVICE_CLIENT_ID`/`M5_SERVICE_CLIENT_SECRET` o, para el entorno local actual, `KEYCLOAK_ADMIN_CLIENT_ID`/`KEYCLOAK_ADMIN_CLIENT_SECRET` del BFF. M9 acepta `SERVICIO`, `solicitud-be` o `reservas-be`; no requiere scopes. El cliente de servicio de M5 debe tener asignado `solicitud-be` (o uno de los otros roles admitidos) y acceso `client_credentials` habilitado. M5 y M9 deben apuntar al mismo servidor/realm de Keycloak, con emisor idéntico; tener el mismo nombre de realm en dos Keycloak distintos no alcanza.
- **URLs locales:** M5 escucha en `http://localhost:3001`; M9 usa ese valor como `M5_DESPACHO_URL`. M5 usa `M9_URL=http://localhost:8089` para el callback. Si uno corre en Docker, cambiar `localhost` por el nombre del servicio o dirección alcanzable desde ese contenedor.

## Pendientes actualizados

Estos pendientes son los que quedan después de los cambios revisados. “Implementado” no significa que se haya probado con los servicios reales.

| Orden | Pendiente | Acción necesaria |
|---|---|---|
| 1 | Aplicar y verificar el esquema de base de datos. | Se ejecutó `npm run db:generate`, pero no `npm run db:push`. Aplicar el esquema en la base de M5 y probar lectura/escritura de solicitudes, rondas, eventos M6 y outbox M8. |
| 2 | Probar M6/RabbitMQ y M8 en ejecución. | Configurar `M6_RABBITMQ_URL` y `M8_URL`; verificar alta, cancelación con/sin redespacho, reconexión, DLQ y entrega/reintento de notificaciones. |
| 3 | Reutilizar el vehículo persistido al repetir una asignación. | M5 guarda `vehiculo_id`, pero al repetir vuelve a consultar M3. Recuperar primero el valor persistido para no cambiar el cuerpo enviado a M6 bajo el mismo `requestId`. |
| 4 | Decidir si se implementa reintento durable del callback M9. | Hoy hay hasta tres intentos HTTP por llamada, pero no recuperación tras agotarlos o reiniciar. Este punto se verificó y quedó sin cambios; requiere decisión de alcance antes de implementar. |
| 5 | Cerrar discrepancias de notificaciones. | Acordar con M8 cómo publicar/aceptar `detalle.conductorId`; solicitar a M9 que envíe `cliente_email` cuando disponga de él. Definir también cómo inspeccionar/reprocesar eventos M8 en estado `FALLIDA`. |
| 6 | Definir estrategia cuando M4 devuelve el máximo de candidatos. | El contrato revisado no tiene paginación y M5 no consulta otra lista al agotar las tandas. Acordar una estrategia compatible con M4. |
| 7 | Confirmar autenticación y configuración integrada. | Verificar emisor, roles/scopes y credenciales para M1/M2/M3/M4/M6/M7/M8/M9. La discrepancia de `tarifas:read` corresponde a la implementación de M7, no se puede resolver editando M5 solamente. |
| 8 | Completar pruebas de extremo a extremo. | Probar frontend → BFF → M5, persistencia MySQL, despacho, cancelación, idempotencia, reinicio y callbacks con los servicios desplegados. |

## Configuración necesaria para una prueba integrada

- Copiar `.env.example` a `.env` y completar base de datos, JWT/Keycloak y credenciales de servicio. No usar secretos de ejemplo en un entorno compartido.
- `M2_URL` de ejemplo apunta a `http://localhost:8082`. `M2_TOKEN` debe corresponder al modo de autenticación que esté usando M2: HS256 de desarrollo o JWT de Keycloak con rol/scope adecuados.
- Configurar las URLs y tokens HTTP de M3, M4, M6 y M7 según el entorno.
- Configurar `M6_RABBITMQ_URL`; sin ella, M5 arranca sin consumir cancelaciones. Configurar `M8_URL`; sin ella, M5 registra una advertencia y no encola/envía eventos a M8.
- Configurar credenciales M2M para el callback M5→M9. `M9_URL` usa `http://localhost:8089` como valor por defecto de desarrollo.
- Para el frontend, ejecutar backend y BFF por separado; `API_URL` debe apuntar al backend M5. `src/main.js` es la API principal; `bd/index.js` es una API anterior y no la reemplaza.

## Verificaciones realizadas

- **Aprobado:** `npm run db:generate`.
- **Aprobado:** 25 pruebas enfocadas de búsqueda M4, cliente HTTP, consumidor/procesador M6 y outbox M8.
- **Aprobado:** parseo de `docs/openapi-a.yml` como YAML; declara OpenAPI 3.1.
- **Pendiente:** `npm run db:push`, porque no se aplicó el esquema a una base real.
- **Pendiente:** pruebas de integración con MySQL, RabbitMQ y servicios M2–M9 desplegados.
- **Limitación conocida:** la suite completa se interrumpe por una prueba preexistente que importa `axios`, dependencia que no está instalada. No se agregó `axios` para esta tarea.

## Criterio para declarar M5 listo

M5 estará verificado para una demostración cuando arranque con su configuración, conecte a MySQL, el frontend llegue a `src/main.js` y se complete un flujo de solicitud/despacho con los servicios requeridos activos. Para dar por cerradas las integraciones, también hay que probar cancelación/redespacho, reintentos, idempotencia, reinicios y los pendientes de la tabla anterior.

Al actualizar este documento, mantener separados tres estados: **contrato documentado**, **implementación en M5** y **conexión probada en ejecución**.
