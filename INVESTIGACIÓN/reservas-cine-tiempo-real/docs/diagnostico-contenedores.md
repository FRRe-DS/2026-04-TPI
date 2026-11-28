# Diagnóstico de la integración en contenedores

La versión recibida separa el REST real del canal WebSocket. El gateway dirige REST a Asientos y WebSocket a un mock de Python. `services/asientos/src/server.js` arranca únicamente REST y el ZIP carece de `src/tiempo-real/`. Por eso se puede obtener una respuesta HTTP correcta y, al conectar el WebSocket, reemplazar la grilla por datos ajenos a MySQL.

La corrección incorpora el módulo de tiempo real con su adaptador, arranca Asientos desde `src/tiempo-real/servidor-integrado.js` y dirige `/ws/sala/` al mismo proceso. Nginx también sirve los archivos existentes de `frontend-cine/public` en `http://localhost:8080`.

| Hallazgo | Comprobación en la versión recibida | Corrección |
| --- | --- | --- |
| WebSocket conectado al mock | `/ws/sala/41` entrega `funcionId=42` y tres asientos. REST devuelve 96 asientos para la función 41. | Enrutar `/ws/sala/` a `servicio-asientos:3001`. |
| Asientos arranca solo REST | `/api/metricas/conexiones` devuelve 404. El Dockerfile ejecuta `src/server.js`. | Incorporar el módulo C y arrancar `src/tiempo-real/servidor-integrado.js`. |
| IDs del mock ajenos a la semilla | El primer asiento recibido por WS es 1001. Su bloqueo REST devuelve `404 NO_ENCONTRADO`. | La foto WebSocket se obtiene de la grilla real. |
| Frontend fuera de Compose | El Compose carece de servicio frontend y Nginx devuelve 404 para `/`. | Montar `frontend-cine/public` en Nginx y servir HTML, CSS y JS. |
| Exceso de solicitudes mostrado como caída | Una ráfaga de 45 consultas devolvió 17 respuestas 200 y 28 respuestas 503. | Configurar `limit_req_status 429`, cuerpo `LIMITE_EXCEDIDO` y `Retry-After`. |
| Código de error al caer un upstream | En la prueba del fallback, Nginx conservaba 502 con la directiva sin estado explícito. | Usar `error_page 502 503 504 =503 @servicio_caido`. |
| Health de los servicios protegido por el gateway | `/api/asientos/health` sin token devuelve 401. | Crear locations exactas de salud antes de las rutas protegidas. |
| JWT expuesto en logs | El access log incluye la consulta completa y el mock imprime la URL. El mock acepta cualquier token no vacío. | Usar `$uri` en el access log, retirar el mock del arranque y validar el JWT en Asientos real. |

El estado de rechazo predeterminado de `limit_req` es 503. Definir 429 permite identificar el límite de solicitudes. El fallback se fija explícitamente para responder 503 cuando el servicio no está disponible. [Nginx, limit_req_status](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html#limit_req_status) · [Nginx, error_page](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page)

El gateway reenvía `Upgrade` y `Connection` con HTTP/1.1. Su timeout de lectura es 60 s y el ping del módulo es de 25 s. Nginx comprueba la presencia de Bearer en REST. La firma HS256, el vencimiento y `sub` se validan en los servicios. La centralización de esa verificación en el gateway sigue siendo un requisito de la arquitectura del TP. [Nginx, proxy WebSocket](https://nginx.org/en/docs/http/websocket.html)

## Archivos y decisiones

| Archivo | Cambio |
| --- | --- |
| `docker-compose.yml` | Cinco servicios, frontend estático en el gateway, puertos internos explícitos y healthchecks de MySQL con el usuario de aplicación y una consulta a la tabla real. |
| `gateway/nginx.conf` | Ruta WS real, frontend, health sin token, errores 429/503 y access log que excluye argumentos. El nivel de error de la ruta WS es `crit`, porque los errores de conexión de Nginx pueden incluir la URL. |
| `services/asientos/Dockerfile` | `npm ci --omit=dev`, puerto 3001 y arranque del módulo integrado. |
| `services/asientos/.dockerignore` | Excluye dependencias del host y archivos `.env` de la imagen de Asientos. |
| `services/asientos/package.json` | Adiciones de `ws`, `start:tiempo-real` y `test:tiempo-real`. |
| `services/asientos/package-lock.json` | Resolución de `ws`, con las dependencias anteriores conservadas. |
| `services/asientos/.env.example` | Variables del módulo de tiempo real al final. |
| `services/asientos/src/tiempo-real/` | Módulo de la integración anterior, con el acceso a los archivos existentes concentrado en `adaptador-asientos.js`. |
| `services/asientos/tests/tiempo-real.test.js` | Suite del módulo con fixtures en un esquema temporal. |

Se cotejaron los bytes de los archivos existentes de `services/asientos/src`, `services/funciones`, `frontend-cine`, tablas, scripts y tests originales contra el ZIP. El contrato conserva su SHA-256. El código del mock queda en la carpeta recibida y Compose ejecuta el canal WebSocket real.

Los nombres de servicio son los hosts internos de la red Compose. Los servicios se comunican con los puertos internos 3001, 3002 y 3306. El navegador accede a `localhost:8080`. `EXPOSE` documenta un puerto. Las conexiones dependen del puerto donde escucha el proceso y del mapeo de Compose. [Docker, networking en Compose](https://docs.docker.com/compose/how-tos/networking/) · [Dockerfile, EXPOSE](https://docs.docker.com/reference/dockerfile/#expose)

## Levantar la copia corregida

Extraer el proyecto completo y abrir una terminal en la carpeta que contiene `docker-compose.yml`. Ejecutar con Docker Desktop iniciado.

```powershell
docker compose config --quiet
docker compose up -d --build --force-recreate --remove-orphans
docker compose ps
docker compose exec servicio-asientos node scripts/generar-token.js ana
```

Abrir `http://localhost:8080` y pegar el JWT que imprime el último comando. Para polling, abrir `http://localhost:8080/polling.html`. Dos pestañas permiten comprobar la difusión del bloqueo. El secreto para firmar es el que figura en Compose y lo toma el generador desde el contenedor.

Al cambiar el arranque, la orden indicada recrea los contenedores. El gateway resuelve los nombres de sus upstreams al iniciar.

Para repetir el test estrella contra el gateway levantado, ejecutar desde la raíz del proyecto. Esta prueba necesita un asiento libre de la función 41.

```powershell
docker compose exec -e BASE_URL=http://gateway:8080 servicio-asientos npm run test:tiempo-real
```

Las pruebas locales completas de C crean y borran un esquema temporal y requieren permisos MySQL de prueba. La prueba contra `BASE_URL` usa las rutas públicas y libera su bloqueo al terminar.

## Si MySQL queda unhealthy en la computadora

El ZIP no contiene los volúmenes persistentes de ejecuciones anteriores. Las variables `MYSQL_USER` y `MYSQL_PASSWORD` y los SQL de `/docker-entrypoint-initdb.d` se aplican al inicializar un directorio de datos vacío. Una reconstrucción conserva los usuarios y tablas que ya estaban en un volumen. [Imagen oficial de MySQL](https://hub.docker.com/_/mysql)

El healthcheck corregido comprueba una conexión TCP con el usuario de la aplicación y consulta su tabla. Esto permite identificar un usuario, contraseña o esquema ausente, aunque `mysqladmin ping` confirme que el servidor está vivo. Compose espera esa condición antes de arrancar Node. [Docker, orden de arranque y service_healthy](https://docs.docker.com/compose/how-tos/startup-order/)

Para ubicar la capa que falla, ejecutar desde la misma carpeta.

```powershell
docker compose ps
docker compose logs --tail=80 db-asientos db-funciones
docker compose logs --tail=80 servicio-asientos servicio-funciones gateway
```

| Mensaje o síntoma | Comprobación concreta |
| --- | --- |
| `Access denied for user` o MySQL unhealthy | Conectar con el usuario de la aplicación y las claves del Compose para esa base. |
| `Table ... doesn't exist` | Verificar las tablas y si el volumen se creó antes de montar los SQL. |
| `host not found in upstream` | Verificar que los servicios estén en ejecución y pertenezcan a la red del proyecto. |
| `Bind ... 8080 ... port is already allocated` | Identificar el proceso o contenedor que ocupa 8080. Un proxy local de las pruebas previas puede estar usando ese puerto. |
| `401` en el catálogo | Generar el token dentro de `servicio-asientos` y usarlo en la web. |
| `429` | Se alcanzó el límite de 10 solicitudes/s por IP. |
| `503 SERVICIO_NO_DISPONIBLE` | Consultar los logs y healthchecks del servicio de destino. |

Para comprobar las bases desde los contenedores, estos comandos piden la contraseña del usuario correspondiente. Ejecutar después las consultas en el cliente MySQL.

```powershell
docker compose exec db-asientos mysql -u asientos_user -p asientos_db
```

```sql
SHOW TABLES;
SELECT COUNT(*) FROM asientos;
```

```powershell
docker compose exec db-funciones mysql -u funciones_user -p funciones_db
```

```sql
SHOW TABLES;
SELECT COUNT(*) FROM funciones;
```

En una semilla recién cargada se esperan 288 asientos y 3 funciones.

Si un volumen conserva credenciales anteriores, conectar como root con la contraseña que tenía ese volumen y alinear el usuario de aplicación con Compose. En `db-asientos`, ejecutar las siguientes sentencias.

```powershell
docker compose exec db-asientos mysql -u root -p
```

```sql
CREATE USER IF NOT EXISTS 'asientos_user'@'%' IDENTIFIED BY 'asientos_pass';
ALTER USER 'asientos_user'@'%' IDENTIFIED BY 'asientos_pass';
GRANT ALL PRIVILEGES ON asientos_db.* TO 'asientos_user'@'%';
```

En `db-funciones`, ejecutar el equivalente para esa base.

```powershell
docker compose exec db-funciones mysql -u root -p
```

```sql
CREATE USER IF NOT EXISTS 'funciones_user'@'%' IDENTIFIED BY 'funciones_pass';
ALTER USER 'funciones_user'@'%' IDENTIFIED BY 'funciones_pass';
GRANT ALL PRIVILEGES ON funciones_db.* TO 'funciones_user'@'%';
```

## Evidencia y alcance de la ejecución

Se ejecutaron Node.js 20.20.2, Nginx 1.26.3 y MySQL 8.4.9 como procesos locales. Se sustituyeron los nombres DNS de Docker por loopback y las rutas de logs, temporales, MIME y frontend por rutas del entorno. Las dos bases se crearon en una misma instancia temporal de MySQL, con usuarios y permisos separados. Compose declara dos instancias MySQL 8.0.

| Verificación | Resultado |
| --- | --- |
| `docker compose config --quiet` original y corregido | PASS. El original ya era válido sintácticamente. |
| Nginx `-t` con las configuraciones adaptadas a loopback | PASS. |
| REST, WS, frontend, métricas, JWT, límite y servicio detenido | PASS en el conjunto local corregido. |
| Tests originales de Asientos | 17/17 PASS. |
| Tests del módulo tiempo real | 16/16 PASS. |
| Tests originales de Funciones | 5/5 PASS. |
| Test estrella con `BASE_URL` a Nginx | 1/1 PASS. |
| Carrera aislada | Un ganador de diez con actualización condicionada. |
| Construcción y arranque con el motor Docker | **NO EJECUTADO**. El entorno bloquea el acceso al socket del motor. |

Las salidas completas están en [antes de corregir](evidencias/contenedores-antes.txt), [después de corregir](evidencias/contenedores-despues.txt), [validación de Compose](evidencias/contenedores-compose.txt), [regresión](evidencias/contenedores-regresion.txt) y [test estrella por Nginx](evidencias/contenedores-estrella-gateway.txt).

El REST de B hace su actualización y su lectura de versión en llamadas separadas. El adaptador recuperado fuerza la resincronización si detecta un aviso incompatible con la fila vigente. La garantía de versión exacta en toda superposición de mutaciones sigue dependiendo de la integración transaccional de Asientos. La demostración `test-carrera.js` y `tests/bloqueo.test.js` también comparten F5 cuando el runner los descubre juntos. Las 17 pruebas originales se ejecutaron por sus dos archivos para aislar ese efecto de la demostración.
