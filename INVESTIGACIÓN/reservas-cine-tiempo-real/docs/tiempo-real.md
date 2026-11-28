# Persona C · Tiempo real en Asientos con arranque alternativo

## Paso 0 y restauración

Volví a extraer `reservas-cine-tiempo-real.rar` y reconstruí la copia de trabajo desde esa extracción. Comparé por ruta el SHA-256 de los archivos completos, incluidos sus saltos de línea. Excluí el directorio de metadatos `.git` y dependencias instaladas. Antes de integrar coincidían **42 de 42 archivos**. En la entrega coinciden **39 de 42** y las únicas diferencias entre los archivos originales son las adiciones permitidas de `services/asientos/package.json`, `package-lock.json` y `.env.example`.

| Archivo revisado | Qué se reutiliza |
| --- | --- |
| `services/asientos/src/app.js` y `src/server.js` | El primero exporta una aplicación Express con todo el REST. El segundo es el arranque original de B. C monta la aplicación exportada en su propio servidor. |
| `src/eventos.js` | El bus de B ya permite `on('cambio', ...)`. El mensaje lleva `funcionId` para seleccionar sala. |
| `src/bloqueo.js` y `src/db.js` | B ejecuta sus `UPDATE` condicionados en MySQL y lee las grillas. C reutiliza la lectura de grilla y el pool. |
| `src/auth.js` y `scripts/generar-token.js` | El middleware Bearer autentica con `JWT_SECRET`, HS256 y `sub`. C usa el middleware en sus métricas. El verificador de WebSocket y el generador de prueba viven en archivos de C. |
| `db/schema.sql`, `db/seed.sql` y `.env.example` | Asientos persiste estado, vencimiento y versión en MySQL. La semilla de B crea 96 asientos en cada función 41, 42 y 43. |
| `tests/api.test.js`, `tests/bloqueo.test.js` y `package.json` | Se ejecuta `npm test` con el `node --test` original. C tiene un script de tests independiente. |
| `scripts/test-carrera.js` y `docs/evidencias/carrera.txt` | Se repite la demostración en una copia descartable y se compara el ganador del `UPDATE` condicionado con los dos registros del RAR. |
| `frontend-cine/public/app.js` y `polling.html` | D consume el JWT en la URL de WebSocket, la grilla, los cambios, el latido y el polling de 2 s. |

El contrato adjunto y `docs/openapi-cine.yaml` del RAR comparten el SHA-256 `5c0d2db10c7fe91dfd96ecd226a54c4d63ff3d31d4ff1509450e5c4adfba4364`.

## Marco teórico · Tema 19

### Upgrade HTTP y conexión persistente

Una pestaña que abre la función envía un GET HTTP/1.1 con `Upgrade: websocket` y `Connection: Upgrade`. El servidor devuelve `101 Switching Protocols`. El navegador comprueba `Sec-WebSocket-Accept`, que se obtiene al concatenar la clave `Sec-WebSocket-Key` con el identificador fijo del protocolo, aplicar SHA-1 y codificar el resultado en Base64. A partir de ahí ambos extremos pueden enviar frames sobre la misma conexión TCP. En el cine, cada pestaña mantiene su socket para recibir cambios puntuales de la función. [RFC 6455, §§ 1.3 y 4](https://www.rfc-editor.org/rfc/rfc6455.html#section-4) · [MDN, WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)

Captura del primer cliente del test estrella. El test verificó el valor de `Sec-WebSocket-Accept` y reemplazó el JWT por `[REDACTADO]` al generar la evidencia.

```http
GET /ws/sala/41?token=[REDACTADO] HTTP/1.1
Host: 127.0.0.1:40729
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: OqOFIC+n8BgvJkXg/qIBMQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: fKYpqR7r8RdZRSxBPS014oIU8Sw=
```

### Alternativas para actualizar la grilla

| Mecanismo | Costo de mantener la vista al día | Demora esperable | Dirección y uso |
| --- | --- | --- | --- |
| Polling | Un GET y una grilla por intervalo y cliente, incluso con la sala quieta. | Depende del próximo GET y del tiempo de respuesta. | El cliente inicia cada consulta. Sirve para vistas con baja frecuencia de cambios o como alternativa de transporte. |
| Long polling | Un GET queda pendiente hasta un cambio o un timeout. El cliente abre el siguiente al recibir respuesta. | Cerca de la llegada del cambio mientras hay un GET pendiente. | El servidor responde a una petición abierta. Útil si la infraestructura admite HTTP con esperas largas. |
| Server-Sent Events | Una respuesta HTTP continua con eventos. | Cerca de la llegada del cambio si los intermediarios dejan pasar el stream. | Servidor → cliente. Alcanza para difundir asientos cuando las acciones del usuario siguen por REST. |
| WebSocket | Un upgrade por cliente, una conexión sostenida y un mensaje por evento y destinatario. | Cerca de la emisión del cambio por el servidor. | Bidireccional. Permite que el cliente confirme el latido de la aplicación sobre el mismo canal. |

El TP usa WebSocket para demostrar difusión por sala y latido bidireccional. Las acciones de compra siguen por REST, así que un flujo SSE también podría actualizar las grillas si solo se necesitara difusión. [RFC 6202, long polling y streaming](https://datatracker.ietf.org/doc/html/rfc6202) · [MDN, Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

### Latido y recuperación

Una caída de Wi-Fi, una traducción NAT que vence o un proxy que corta por inactividad pueden dejar a un extremo creyendo que sigue conectado. Asientos envía el mensaje JSON `ping` cada 25 s por defecto. Un socket sin `pong` al ciclo siguiente sale de la sala. Son mensajes de la aplicación, independientes de los frames de control Ping y Pong del protocolo. D puede reintentar ante un corte con esperas de 1, 2 y 4 s, y doblarlas hasta 30 s para distribuir el trabajo de reconexión. [Documentación de ws, detección de conexiones interrumpidas](https://github.com/websockets/ws#how-to-detect-and-close-broken-connections) · [RFC 6455, §§ 5.5.2–5.5.3](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.2)

Mientras una pestaña estuvo desconectada pudo vencer su bloqueo o venderse un asiento. Por eso recibe una foto completa desde MySQL al volver. Desde esa foto, aplica cambios por asiento con una `version` mayor a la que ya conoce. La cola de arranque cubre el tiempo en que el servidor arma la foto mientras llegan escrituras REST.

### Autenticación y límites

El constructor WebSocket del navegador admite una URL y subprotocolos. El contrato lleva el JWT en la consulta y Asientos lo valida al conectar. El código limita los mensajes entrantes, evita registrar URLs, encabezados y cuerpos y acepta solo el `pong` como acción de cliente. Los parámetros de consulta pueden quedar en logs de intermediarios o diagnósticos. Para el despliegue, A debe terminar TLS para servir `wss://`, excluir los argumentos de los logs de acceso y definir orígenes permitidos para la web de D. La validación de `Origin` queda para esa configuración. [MDN, constructor WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket) · [RFC 6455, §§ 10.2–10.6](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2) · [OWASP, parámetros sensibles en la URL](https://owasp.org/www-community/vulnerabilities/Information_exposure_through_query_strings_in_url)

### Punto de contacto con el gateway · Tema 5

La ruta `/ws/sala/{funcionId}` necesita HTTP/1.1 hacia Asientos y reenviar `Upgrade` y `Connection`. Si faltan, el servicio no recibe el pedido de cambiar de protocolo. Nginx abre el túnel cuando obtiene el `101`. Un `proxy_read_timeout` de 60 s deja margen para el ping de 25 s. Con un timeout menor que el intervalo, una sala sin cambios puede perder conexiones antes del latido. El túnel WebSocket debe entregar los frames a medida que llegan. Si se eligiera un stream HTTP como SSE, `proxy_buffering off` evita que Nginx acumule la respuesta y demore la actualización. [Nginx, WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) · [Nginx, proxy buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

## Diseño del arranque integrado

- **HTTP y métricas.** `npm run start:tiempo-real` inicia `src/tiempo-real/servidor-integrado.js`. Monta las métricas y el contador antes del `app` de B. El contador usa una marca monotónica al terminar cada GET autenticado de grilla con ID válido, incluso si la función no existe. `req.usuario` permite contar tras la autenticación de B. Las marcas de más de 3600 s se descartan y el ping queda fuera de `mensajesEmitidos`.
- **Sala y foto inicial.** Con JWT válido, C comprueba la existencia de la función y luego acepta el upgrade. Agrega el socket a la sala antes de leer la grilla. Envía `estado_completo` primero y aplica el filtro de versiones tanto a los cambios encolados como a los posteriores.
- **Cambios REST.** C se suscribe al bus original. El oyente verifica de forma asíncrona, con una consulta de solo lectura, si el aviso coincide con la fila actual. Los avisos verificados se difunden a la sala. Ante una discrepancia se cierra con `1011` a los clientes que aún necesitarían ese cambio. El siguiente `estado_completo` recupera la fila vigente.
- **Vencimiento.** El barrido de C ejecuta un `UPDATE` por `id`, versión esperada, estado `bloqueado` y vencimiento comparado con `NOW()`. Es la única escritura del módulo de tiempo real. Si la actualización afectó una fila, C emite `asiento_liberado` con `bloqueo_vencido` y la versión incrementada. Un nuevo bloqueo que cambió la versión hace fallar la condición del barrido.
- **Apagado.** `SIGTERM` y `SIGINT` detienen la entrada HTTP y los temporizadores. El arranque alternativo cierra los WebSockets con `1000`, desuscribe su oyente y cierra el pool de MySQL.

Una alternativa de solo lectura podría advertir que pasó la fecha, pero la fila seguiría con la misma versión. Si C inventara `version + 1` para la liberación, un bloqueo real posterior podría usar ese mismo número y quedar descartado por el cliente. El barrido escribe el estado y la versión juntos en el mismo `UPDATE`. Usa el pool de B y supone autocommit, el reloj UTC de MySQL y una sola instancia de Asientos sobre esa base para la demo.

| Variable | Predeterminado | Uso |
| --- | ---: | --- |
| `PORT` | 3001 | Puerto común para REST, métricas y WebSocket. |
| `JWT_SECRET` | requerido | Secreto que comparten el middleware de B y el verificador WS. |
| `SEGUNDOS_BLOQUEO` | 60 | TTL que escribe el REST de B. |
| `INTERVALO_VENCIMIENTO_MS` | 5000 | Cadencia del barrido de C en este arranque. |
| `WS_PING_INTERVAL_MS` | 25000 | Cadencia del ping JSON. |
| `WS_MAX_PAYLOAD_BYTES` | 1024 | Tamaño máximo de mensaje entrante. |
| `WS_TIEMPO_GRILLA_MS` | 10000 | Plazo de verificación de función y de la foto inicial. |
| `WS_MAX_CAMBIOS_PENDIENTES` | 256 | Capacidad de la cola por conexión mientras se arma la foto. |
| `WS_CIERRE_TIMEOUT_MS` | 2000 | Plazo de espera del cierre de protocolo. |

## Archivos de B modificados

En `services/asientos/` hay tres archivos originales con cambios. Se agregaron cinco variables y su comentario al final de `.env.example`, tres scripts y `ws` en `package.json`, y la resolución de `ws` generada por npm en `package-lock.json`.

```diff
diff --git a/services/asientos/.env.example b/services/asientos/.env.example
index 09bca4f..2fd9fef 100644
--- a/services/asientos/.env.example
+++ b/services/asientos/.env.example
@@ -10,3 +10,9 @@ JWT_SECRET=
 # Opcionales
 SEGUNDOS_BLOQUEO=60
 INTERVALO_VENCIMIENTO_MS=5000
+# Tiempo real (arranque alternativo)
+WS_PING_INTERVAL_MS=25000
+WS_MAX_PAYLOAD_BYTES=1024
+WS_TIEMPO_GRILLA_MS=10000
+WS_MAX_CAMBIOS_PENDIENTES=256
+WS_CIERRE_TIMEOUT_MS=2000
diff --git a/services/asientos/package-lock.json b/services/asientos/package-lock.json
index 0462af4..de1ed9c 100644
--- a/services/asientos/package-lock.json
+++ b/services/asientos/package-lock.json
@@ -11,7 +11,8 @@
         "dotenv": "^18.0.10",
         "express": "^5.3.0",
         "jsonwebtoken": "^9.0.3",
-        "mysql2": "^3.24.6"
+        "mysql2": "^3.24.6",
+        "ws": "^8.22.2"
       }
     },
     "node_modules/@types/node": {
@@ -1117,6 +1118,27 @@
       "resolved": "https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz",
       "integrity": "sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==",
       "license": "ISC"
+    },
+    "node_modules/ws": {
+      "version": "8.22.2",
+      "resolved": "https://registry.npmjs.org/ws/-/ws-8.22.2.tgz",
+      "integrity": "sha512-/rEZ2ejown2N5gxVTHUu9bVVC7ttu0/Tgzf5hbTOixR3Fs7mbbXgn2DbdbcKgJOmpQMtrIUWivtYuVMnp/W/yA==",
+      "license": "MIT",
+      "engines": {
+        "node": ">=10.0.0"
+      },
+      "peerDependencies": {
+        "bufferutil": "^4.0.1",
+        "utf-8-validate": ">=5.0.2"
+      },
+      "peerDependenciesMeta": {
+        "bufferutil": {
+          "optional": true
+        },
+        "utf-8-validate": {
+          "optional": true
+        }
+      }
     }
   }
 }
diff --git a/services/asientos/package.json b/services/asientos/package.json
index d30afaf..dabfeb4 100644
--- a/services/asientos/package.json
+++ b/services/asientos/package.json
@@ -10,12 +10,16 @@
     "db:init": "node scripts/init-db.js",
     "token": "node scripts/generar-token.js",
     "test": "node --test",
+    "start:tiempo-real": "node src/tiempo-real/servidor-integrado.js",
+    "test:tiempo-real": "node --test tests/tiempo-real.test.js",
+    "medir:tiempo-real": "node scripts/medir-tiempo-real.js",
     "test:carrera": "node scripts/test-carrera.js"
   },
   "dependencies": {
     "dotenv": "^18.0.10",
     "express": "^5.3.0",
     "jsonwebtoken": "^9.0.3",
+    "ws": "^8.22.2",
     "mysql2": "^3.24.6"
   }
 }
```

## Adaptador de Asientos

[`adaptador-asientos.js`](../services/asientos/src/tiempo-real/adaptador-asientos.js) concentra los imports a los archivos existentes. El servidor usa su interfaz para montar REST, autenticar, suscribirse a cambios, leer grillas y ejecutar el barrido. El benchmark usa la misma interfaz para registrar el instante de publicación.

| Dependencia de Asientos | Contrato que espera el adaptador |
| --- | --- |
| `src/app.js` | Exporta una app Express montable y carga `.env`. La ruta de grilla acepta un ID entero positivo y deja `req.usuario` si autentica la solicitud. |
| `src/auth.js` | Exporta middleware Bearer. Usa HS256, `JWT_SECRET` y `sub`. El adaptador aplica las mismas reglas al token del upgrade WebSocket. |
| `src/eventos.js` | Emite `cambio` después de escribir. El aviso trae `funcionId`, `asientoId`, `fila`, `numero`, `version` y los campos del mensaje OpenAPI. Ofrece `on`, `off`, `prependListener` y el formateador `mensajes.liberado`. El adaptador entrega el mensaje y devuelve una función para desuscribirse. |
| `src/bloqueo.js` | `obtenerGrilla(funcionId)` devuelve el array de asientos. Un bloqueo vencido se proyecta como libre. Una función existe para Asientos si tiene filas. |
| `src/db.js` y tabla `asientos` | Expone un pool `mysql2/promise` con `execute()` y `end()`, UTC y autocommit. La clave es `id`. La fila conserva `funcion_id`, `fila`, `numero`, `estado`, `bloqueado_por`, `bloqueado_hasta` y `version`. Una transición incrementa la versión en uno. |

El REST que recibe las mutaciones y el WebSocket comparten proceso y bus. Para la demo se usa `npm run start:tiempo-real` sobre la base de prueba. Un segundo proceso con barrido propio podría consumir un vencimiento sin notificar a los sockets de la primera instancia.

Búsqueda ejecutada desde la raíz del repo, con el adaptador excluido. Código de salida de `rg` igual a 1 y salida vacía.

```bash
rg -n '\.\./' services/asientos/src/tiempo-real/ -g '!adaptador-asientos.js'
```

El `funcionId` interno sirve para enrutar. Los mensajes de cambio llevan la versión del asiento y el servidor descarta las versiones ya enviadas o superadas.

## Requisitos de integración

Los tres parches están **sin aplicar**. Se verificaron juntos con `git apply --check docs/propuestas-para-B/*.patch`.

### Versión asociada a la mutación REST

**Comportamiento actual.** El `UPDATE` y la lectura del asiento ocurren por separado. Si una liberación se confirma antes de la lectura del bloqueo, el aviso de bloqueo puede llevar la versión de la liberación y una fecha nula. Ante una inconsistencia detectable, el módulo descarta ese aviso y fuerza una reconexión. La foto recupera el estado vigente y el cliente puede perder la transición intermedia. Dos mutaciones del mismo tipo también pueden producir avisos indistinguibles si ambas lecturas ven la última fila.

**OpenAPI lo exige.** Las operaciones de bloquear, liberar y confirmar anuncian el cambio correspondiente. `Asiento.version` se incrementa con cada transición y los tres esquemas de mensaje requieren `version`. La versión publicada debe corresponder al cambio anunciado. [Contrato OpenAPI](openapi-cine.yaml)

**Integración.** El parche conserva la fila de cada mutación dentro de la transacción y publica después del commit. Con esa garantía, `verificarCambio` puede validar el evento confirmado sin cotejar su versión con una fila que ya cambió. Verificar un bloqueo y una liberación superpuestos y comprobar las versiones de ambos avisos. [version-confirmada.patch](propuestas-para-B/version-confirmada.patch) · [MySQL 8.4, bloqueos en InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)

### Proyección de un vendido en REST

**Comportamiento actual.** El REST de confirmación y las lecturas REST pueden devolver el usuario del último bloqueo en `bloqueadoPor` para un asiento vendido. La foto WebSocket ya proyecta `null`.

**OpenAPI lo exige cuando se incluye el campo.** El esquema `Asiento` describe `bloqueadoPor` como nulo para un asiento que no está bloqueado. El campo es opcional. [Contrato OpenAPI](openapi-cine.yaml)

**Integración.** El parche corrige la proyección REST. Verificar que la confirmación, la consulta individual y la grilla REST devuelvan `bloqueadoPor: null` para el asiento vendido. [bloqueado-por-en-rest.patch](propuestas-para-B/bloqueado-por-en-rest.patch)

### Aislamiento de la demostración de carrera

**Comportamiento actual.** El descubrimiento de `node --test` puede ejecutar en paralelo `scripts/test-carrera.js` y `tests/bloqueo.test.js`. Ambos escriben F5 en la función 42. Los reinicios de un caso interfieren con las aserciones del otro y vuelven intermitente `npm test`. La variante condicionada de la demostración aislada conserva un ganador.

**OpenAPI no lo exige.** El contrato describe el resultado de concurrencia de la API. Separar las filas de prueba es un requisito para que la verificación del repositorio sea reproducible. [Contrato OpenAPI](openapi-cine.yaml)

**Integración.** El parche mueve la demostración a F7 y mantiene F5 y F6 para las suites existentes. Volver a ejecutar `npm test` y `npm run test:carrera` sobre la semilla. [aislar-asiento-carrera.patch](propuestas-para-B/aislar-asiento-carrera.patch)

## Observaciones al contrato y acuerdos del equipo

| Punto | Interpretación o acuerdo |
| --- | --- |
| Autenticación y existencia | Asientos directo cierra con `1008` ante JWT inválido. A puede responder HTTP `401` antes del upgrade. Con JWT válido, la función inexistente obtiene `404` antes del upgrade. Una falla de MySQL en esa comprobación devuelve `503`. |
| Otros cierres | Un latido sin respuesta termina el transporte y el cliente observa `1006`. `ws` usa `1009` al superar el máximo de mensaje entrante. |
| Ventana de métricas | Si falta `ventanaSegundos`, vale 60. Un valor fuera de 1–3600 devuelve `400` con `SOLICITUD_INVALIDA`. |
| REST de B | B devuelve `409 ASIENTO_VENDIDO` al hacer DELETE de un asiento ya vendido. OpenAPI no detalla ese caso. |
| A · Gateway | Apuntar REST, métricas y `/ws/sala/` al puerto del arranque alternativo. Compartir `JWT_SECRET`, reenviar el upgrade y dejar un timeout de lectura mayor que el ping. |
| D · Frontend | La primera foto, el orden por versión y el latido se mantienen. Ante `1011`, el código de D reintenta y recibe una grilla nueva. |

## Pruebas y reproducción

Se usó Node.js 20.20.2 y MySQL Community Server 8.4.9. La verificación de B se hizo con `npm test`, que ejecuta su `node --test` original. El descubrimiento automático encuentra el archivo de C. Ese archivo se marca como omitido durante el ciclo `npm test` y se ejecuta completo con `npm run test:tiempo-real`. [npm, variable del ciclo de vida](https://docs.npmjs.com/cli/v11/using-npm/scripts/#current-lifecycle-event)

En el modo local, C clona la **estructura** de `asientos` en un esquema temporal de nombre aleatorio, crea sus propias filas y elimina el esquema al terminar. El usuario MySQL de prueba necesita permiso para crear y borrar ese esquema. C no depende de las filas de las pruebas de B ni de su orden. El vencimiento se prueba con TTL de 2 s y el barrido real. La prueba de resincronización ejecuta dos mutaciones REST reales y entrega al suscriptor un aviso de bloqueo construido con la relectura de la liberación.

### `npm test` de B

```text
1..19
# tests 19
# pass 18
# fail 0
# cancelled 0
# skipped 1
# duration_ms 329.796093
```

En esta revisión, las dos primeras corridas de `npm test` registraron una y dos fallas en los casos que usan F5. La tercera pasó. La evidencia conserva las tres y la reproducción anterior en el RAR intacto. Los dos archivos de tests originales, ejecutados juntos con `node --test tests/api.test.js tests/bloqueo.test.js` en una base recién sembrada, dieron el siguiente resultado.

```text
1..17
# tests 17
# pass 17
# fail 0
# cancelled 0
# skipped 0
# duration_ms 326.400155
```

### `npm run test:tiempo-real` de C

```text
1..16
# tests 16
# pass 16
# fail 0
# cancelled 0
# skipped 0
# duration_ms 4287.991199
```

La prueba estrella también pasó con `BASE_URL` apuntando al arranque alternativo en otro proceso. Ese proceso recibió `SIGTERM`, cerró el socket con `1000` y salió con código 0.

### `npm run test:carrera`

```text
Prueba de condición de carrera - 2026-11-12T01:49:47.341Z
Asiento F5 de la función 42 (id 104), 10 usuarios a la vez

Ingenua (leer y después escribir): 10 éxitos de 10 intentos simultáneos   <- MAL: varios creen que lo ganaron
Condicionada (un solo UPDATE)   : 1 éxitos de 10 intentos simultáneos   <- BIEN: gana exactamente uno
```

Los dos registros originales de `docs/evidencias/carrera.txt` tienen un ganador de diez en la variante condicionada, igual que la corrida de esta entrega. En la variante ingenua, los registros del RAR muestran uno y diez ganadores. La corrida aislada de esta entrega mostró diez. La demostración se ejecutó en una copia descartable porque el script agrega su salida a `carrera.txt`.

[Salida de B](evidencias/pruebas-b.txt) · [Salida de C y prueba del arranque alternativo](evidencias/pruebas-tiempo-real.txt) · [Salida de la carrera](evidencias/carrera-tiempo-real.txt) · [Captura HTTP](evidencias/handshake-tiempo-real.txt)

Desde una copia con una base de prueba configurada en `.env` de Asientos, correr los comandos siguientes. `db:init` recrea la tabla de la semilla de B.

```bash
cd services/asientos
npm ci
npm run db:init
npm test
npm run test:tiempo-real
npm run test:carrera
npm run medir:tiempo-real -- --csv ../../docs/evidencias/mediciones-tiempo-real.csv
npm run start:tiempo-real
```

`node scripts/generar-token-tr.js usuario` genera un token de prueba. Acepta `--vencido` o `--firma-invalida`.

Con el gateway configurado se puede repetir el test estrella y las mediciones mediante `BASE_URL`. El test externo acepta `FUNCION_ID`, `OTRA_FUNCION_ID` y `ASIENTO_ID`.

```bash
BASE_URL=http://localhost:8080 npm run test:tiempo-real
BASE_URL=http://localhost:8080 npm run medir:tiempo-real -- --csv mediciones-gateway.csv
```

En PowerShell, asignar `$env:BASE_URL = 'http://localhost:8080'` antes de ejecutar los mismos comandos sin el prefijo Bash. Para medir desde la publicación del cambio con un reloj único, el benchmark inicia Asientos en su propio proceso. Si el gateway debe intervenir, se puede usar `--puerto-local 3001` y apuntar el proxy a esa instancia. Contra un proceso externo, el benchmark mide volumen y marca sus latencias poscommit como **no medido**.

## Comparación medida

| Clientes | Mecanismo | Solicitudes/min (TP) | Fórmula teórica | Prom. (ms) | p95 (ms) | Máx. (ms) |
| ---: | --- | ---: | --- | ---: | ---: | ---: |
| 3 | WebSocket | 24 | 3 × (6 + 2) = 24 | 2.185 | 3.211 | 3.211 |
| 3 | Polling 2 s | 90 | 3 × 60 / 2 = 90 | 1174.039 | 1937.974 | 1937.974 |
| 10 | WebSocket | 80 | 10 × (6 + 2) = 80 | 2.199 | 3.223 | 3.259 |
| 10 | Polling 2 s | 300 | 10 × 60 / 2 = 300 | 1188.887 | 1948.150 | 1949.994 |
| 50 | WebSocket | 400 | 50 × (6 + 2) = 400 | 3.222 | 5.772 | 6.316 |
| 50 | Polling 2 s | 1500 | 50 × 60 / 2 = 1500 | 1229.296 | 2007.961 | 2011.249 |

La tabla conserva las seis fases medidas en la revisión anterior del arranque adaptado. En esta revisión se verificó el benchmark con 3 clientes, 6 s y 2 cambios por mecanismo. Llegaron las 12 observaciones previstas. Su salida figura al final del registro de mediciones.

Cada fase de la tabla duró 60 s y ejecutó seis cambios REST alternando bloqueo y liberación sobre el mismo asiento. Polling comenzó a los 500 ms y repitió cada 2 s. Se tomó la primera marca monotónica en el aviso poscommit de B antes de la verificación de C. Se tomó la segunda cuando el cliente interpretó por primera vez la misma versión. El p95 usa la posición `ceil(0,95 × muestras)` de las demoras ordenadas. Las mutaciones y las consultas de control quedan fuera de ambos conteos.

- Las seis fases registraron las 756 observaciones previstas.
- WebSocket hizo 3, 10 y 50 upgrades HTTP. Con la foto inicial y los cambios por cliente, los totales del TP fueron 24, 80 y 400.
- Polling hizo 30 GET por cliente. Los 90, 300 y 1500 GET coincidieron con el contador del servidor.
- El p95 de WebSocket fue de 3.211 a 5.772 ms. Incluye el SELECT con el que C verifica el aviso del bus.
- El p95 de polling fue de 1937.974 a 2007.961 ms. La fase de 50 clientes registró un máximo de 2011.249 ms.
- Los tiempos corresponden a clientes sincronizados por loopback y una instancia de Asientos con MySQL.

[Tabla comparativa](evidencias/tabla-comparativa.md) · [Salida real](evidencias/mediciones-tiempo-real.txt) · [CSV por cliente y versión](evidencias/mediciones-tiempo-real.csv)

**Gateway · NO EJECUTADO.** El RAR viene sin gateway ni Docker Compose. Sus solicitudes/min y latencias figuran como **no medido**.

## Escalar a dos réplicas

Cada proceso conoce únicamente los sockets conectados a él. Una escritura REST cambia MySQL para todos, pero el aviso del `EventEmitter` solo existe en el proceso donde ocurrió. El mismo límite aplica al barrido. La afinidad de un cliente con una réplica conserva su conexión, pero una sala puede tener espectadores en ambas.

Redis Pub/Sub permitiría publicar el evento confirmado con `funcionId`, asiento y versión. Cada instancia difundiría los mensajes del canal a sus sockets locales. La foto desde MySQL permite recuperar el estado al reconectar. Redis Pub/Sub entrega como máximo una vez. Para garantizar recuperación de eventos entre un commit y una caída de proceso, haría falta guardar el evento junto con la escritura de MySQL y despacharlo por un canal durable. [Redis, semántica de Pub/Sub](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics)

## Checklist

| Entregable | Estado |
| --- | --- |
| Restauración y cotejo byte por byte | Verificados antes y después. Solo tres adiciones en archivos originales. |
| REST bajo el arranque alternativo y métricas | Hecho y probado. Imports a archivos existentes concentrados en el adaptador. |
| WebSocket por función, JWT, latido y reconexión | Hecho y probado. |
| Vencimientos con versión persistida | Hecho y probado con un `UPDATE` condicionado en C. |
| Versión exacta ante mutaciones REST superpuestas | Parcial. Verificación contra la fila vigente y resincronización. Parche propuesto sin aplicar. |
| Proyección de `bloqueadoPor` para vendidos | Conforme en WebSocket. REST conserva la proyección de B y tiene un parche propuesto sin aplicar. |
| Regresión de B, suite de C y demostración de carrera | Ejecutadas. Las dos suites de B pasan aisladas. Falla intermitente del comando completo reproducida en el RAR. Un ganador en la carrera aislada. |
| Comparación con 3, 10 y 50 clientes | Evidencia de la revisión anterior. Verificación breve repetida con el adaptador. |
| Repetición a través del gateway | NO EJECUTADO. |
