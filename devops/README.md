# devops/ — aporte del equipo DevOps (Grupo 5) a M5 G04

Esta carpeta, `.github/workflows/ci.yml`, el `Dockerfile` y el `.dockerignore` son el aporte del
equipo DevOps del TP Integrador Intercátedra. **No modifican la lógica funcional del módulo**:
agregan CI, pruebas E2E, análisis de seguridad, la imagen Docker y la bitácora del trabajo
conjunto. Todo cambio entra por Pull Request y lo revisa el grupo G04.

La misma estructura existe en el repo de G13 (consorcio B): los dos repos implementan M5 y se
gestionan con el mismo contrato, para poder comparar las dos implementaciones.

```
.github/workflows/ci.yml       pipeline de CI
Dockerfile, .dockerignore      imagen del backend
devops/
├── bitacora.md                bitácora compartida DevOps <-> Desarrollo (igual en G04 y G13)
├── ci/
│   ├── junit_summary.py       resumen de tests (JUnit) en la página de la ejecución (igual en G13)
│   ├── sarif_gate.py          Quality Gate de SAST sobre los resultados de CodeQL (igual en G13)
│   ├── m1_tokens_prueba.py    reemplazo de Keycloak en el CI: clave y tokens de prueba (igual en G13)
│   └── gitleaks.toml          reglas de gitleaks + falsos positivos revisados a mano
├── k6/
│   ├── e2e.js                 flujo E2E de G04
│   └── lib/
│       ├── api.js             adaptador de la API de G04
│       └── mocks.js           consultas al mock para verificar las llamadas a otros módulos (igual en G13)
└── mocks/mappings/            mocks de los módulos dependientes (WireMock), iguales en G13
```

## Pipeline (`ci.yml`)

Se ejecuta al **abrir o actualizar un PR hacia `main`**, en cada **push a `main`** y a mano
(*Run workflow*).

| Job | Qué verifica | Si falla |
|---|---|---|
| `build` | `npm ci`, cliente de Prisma, sintaxis de `src/` y que `src/main.js` cargue | Bloquea `unit-tests`, `e2e` y `docker` |
| `unit-tests` | `node --test` (fakes en memoria, como hoy). Publica el resumen y el reporte JUnit | Falla si algún test falla |
| `e2e` | La app con **MySQL 8.4 real** (esquema aplicado con `prisma db push`) y **mocks de M1, M2, M3, M4, M6, M7 y M8**, recorrida con **k6** | Falla si alguna verificación falla |
| `sast` | **CodeQL** (`javascript-typescript`, `security-extended`) + Quality Gate | Falla con alertas **altas o críticas** |
| `secrets` | **gitleaks** sobre el árbol actual y los commits nuevos | Falla si encuentra un secreto |
| `docker` | Build de la imagen con el `Dockerfile` (no se publica) | Falla si no construye |

Los resultados quedan en la pestaña *Actions*: el resumen de cada job y los artefactos (JUnit,
reportes k6, SARIF). Las alertas de CodeQL también aparecen en *Security → Code scanning*.

El job `unit-tests` corre los mismos archivos que `npm test` (`tests/`, `src/**/*.test.js` y
`tests/TestSolicitud.js`), así que en local se prueban igual con `npm test`.

### Quality Gate de SAST

- **Bloquean** el PR las alertas con *security-severity* ≥ 7.0 (**altas** y **críticas**).
- Las **medias** y **bajas** se informan en el resumen sin bloquear.
- El umbral se cambia en un solo lugar: `--umbral` en el job `sast`.

### E2E

El flujo está en `devops/k6/e2e.js`. Corre con 1 usuario virtual: es una verificación funcional,
no una prueba de carga. Es la base de los escenarios de carga del Hito 3.

1. **Solicitud inmediata (RF-5.1)**, con las mismas verificaciones que el E2E de G13: sin token 401,
   token sin rol `CLIENTE` 403, sin `Idempotency-Key` 400; con token, 201 con el cliente tomado del
   token y la tarifa de M7. La misma clave devuelve la misma solicitud (200) y con otros datos da
   409. M2 se consulta una sola vez.
2. **Despacho (RF-5.3/5.4):** una oferta por cada candidato de M4, cada conductor reservado en M4
   antes de ofertarle, las ofertas enviadas a M3 y la solicitud en `buscando`.
3. **Asignación única (RF-5.5/5.6, RNF-08):** los dos conductores aceptan **a la vez**; uno recibe
   200 con el id del viaje y el otro 409. La solicitud queda asignada al ganador, la otra oferta
   cancelada, M6 crea **un solo** viaje y M8 recibe el evento `VIAJE_ASIGNADO`.
4. Sin conductores disponibles → `sin_disponibilidad`.
5. **Cancelación previa (RF-5.7):** sin rol `CLIENTE` 403, titular 200, repetir 200 (idempotente)
   y las ofertas en curso quedan canceladas.

> **El E2E encontró un error que ya está corregido.** Hasta el commit `050ebda`, `iniciarDespacho` no pasaba la
> solicitud de `pendiente` a `buscando`, así que ninguna aceptación podía asignar (las dos recibían
> 409) y la búsqueda sin candidatos no cerraba. G04 lo corrigió el 28/11 en ese commit: con
> ese cambio el E2E pasa completo (35/35). Los tests unitarios no lo detectaban porque sus datos de
> prueba arrancan en `buscando`.

### Mocks de los módulos dependientes

Un único WireMock atiende a todos los módulos, cada uno en sus rutas. Son los mismos archivos en
G04 y G13; cada implementación usa los que necesita.

| Módulo | Ruta | Respuesta | Contrato |
|---|---|---|---|
| M1 (Keycloak) | `POST /realms/{realm}/protocol/openid-connect/token` | Token de servicio de M5 | — |
| M1 (Keycloak) | `GET /realms/{realm}/protocol/openid-connect/certs` | Clave pública (la genera `m1_tokens_prueba.py` en cada corrida) | — |
| M2 | `GET /api/v1/clientes/{id}/estado-cuenta` | `ACTIVO` | Oficial |
| M3 | `POST /api/v1/integration/m5/offers` | 202 | Acordado en el consorcio A |
| M3 | `POST /api/v1/integration/drivers/dispatch-info` | Conductor habilitado con su vehículo | Acordado en el consorcio A |
| M4 | `GET /api/v1/rutas/estimacion` | 6,2 km y 14 min | Oficial |
| M4 | `GET /api/v1/conductores/cercanos` | `AUTO`: 2 candidatos · `MOTO`: lista vacía · `origen_latitud=-27.0`: 503 | Oficial |
| M4 | `POST /api/v1/conductores/{id}/reserva` | Reserva o liberación aceptada | Oficial |
| M6 | `POST /trips` | Viaje creado (id derivado del `requestId`, idempotente) | Oficial |
| M7 | `POST /api/v1/tarifas/estimaciones` | Total 4400 ARS | Oficial |
| M8 | `POST /api/v1/eventos` | 202 | Oficial |

Los tokens (cliente, cliente sin rol y servicio de M3 con `m5:offers:respond`) los firma
`devops/ci/m1_tokens_prueba.py` con una clave RSA que se genera en cada corrida. El
`INTERNAL_API_TOKEN` también se genera en cada corrida: no hay secretos en el repo.

### Imagen Docker

`Dockerfile` en dos etapas: la primera instala dependencias y genera el cliente de Prisma; la
segunda queda solo con lo necesario para correr, con el usuario `node` (sin privilegios) y un
`HEALTHCHECK` sobre `/health`. La configuración se pasa por variables de entorno. Pendiente para
el despliegue: hoy pesa ~800 MB porque el CLI de Prisma queda instalado (`@prisma/client` lo
declara como dependencia par).

### Secretos

`devops/ci/gitleaks.toml` excluye solo falsos positivos revisados a mano: valores de relleno de los
archivos de ejemplo ("reemplazar…", "cambiar…"), los tokens falsos de
`tests/comun/seguridad.test.js` y el encabezado `Sec-WebSocket-Key` de la documentación del
proyecto de investigación (es un valor aleatorio del protocolo WebSocket, no un secreto).

**El job `secrets` falla hoy a propósito**: `.env.example` y `front/.env.example` tienen un
`INTERNAL_API_TOKEN` y un `KEYCLOAK_ADMIN_CLIENT_SECRET` reales (commit `20b617c`, 25/11). Hay que
**rotarlos** (generar valores nuevos donde se usen) y dejar en los `.env.example` valores de
ejemplo. Sacarlos del archivo no alcanza, porque siguen en el historial de git (RNF-06).

## Correr el E2E localmente

Requiere Docker, Node 22 y Python 3 con `pyjwt[crypto]`. Desde la raíz del repo:

```bash
# MySQL y mocks
docker run -d --name ci-mysql -p 13306:3306 -e MYSQL_ROOT_PASSWORD=root_ci \
  -e MYSQL_DATABASE=despacho -e MYSQL_USER=m5_user -e MYSQL_PASSWORD=m5_ci mysql:8.4
docker run -d --name mocks -p 8089:8080 -v "$PWD/devops/mocks:/home/wiremock:ro" wiremock/wiremock:3.13.2

# Variables de M5 (los módulos dependientes apuntan a los mocks)
export PORT=3001 DB_HOST=127.0.0.1 DB_PORT=13306 DB_USER=m5_user DB_PASSWORD=m5_ci DB_NAME=despacho \
       KEYCLOAK_URL=http://127.0.0.1:8089 KEYCLOAK_REALM=ds-2026-realm JWT_AUDIENCE=m5-g04 \
       KEYCLOAK_ISSUER=http://127.0.0.1:8089/realms/ds-2026-realm KEYCLOAK_AUDIENCE=m5-g04 \
       M5_SERVICE_CLIENT_ID=m5-g04 M5_SERVICE_CLIENT_SECRET=descartable-ci \
       M2_URL=http://127.0.0.1:8089 M2_TOKEN=token-de-servicio-ci M3_URL=http://127.0.0.1:8089 \
       M3_TOKEN=token-de-servicio-ci M4_URL=http://127.0.0.1:8089 M4_TOKEN=token-de-servicio-ci \
       M6_URL=http://127.0.0.1:8089 M6_TOKEN=token-de-servicio-ci M7_URL=http://127.0.0.1:8089 \
       M8_URL=http://127.0.0.1:8089 M9_URL=http://127.0.0.1:8089 \
       INTERNAL_API_TOKEN="$(openssl rand -hex 32)"

# Esquema, tokens de prueba y M5 (esperar a que MySQL esté listo)
npm ci && npm run db:generate && npm run db:push
python devops/ci/m1_tokens_prueba.py --mock http://127.0.0.1:8089 > /tmp/m5-tokens.env
node src/main.js &

# E2E
docker run --rm --add-host=host.docker.internal:host-gateway --env-file /tmp/m5-tokens.env \
  -v "$PWD/devops/k6:/scripts:ro" grafana/k6:2.4.0 \
  run -e BASE_URL=http://host.docker.internal:3001 -e MOCKS_URL=http://host.docker.internal:8089 /scripts/e2e.js

# Limpieza
docker rm -f ci-mysql mocks; rm /tmp/m5-tokens.env
```

Las credenciales de MySQL de arriba y del workflow son **descartables**: la base solo existe
mientras dura la prueba. Las credenciales reales nunca van al repo (RNF-06).
