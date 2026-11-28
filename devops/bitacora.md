# Bitácora de avances — M5 Solicitud y Despacho · Grupo 5 DevOss V2

> Bitácora única y compartida entre el equipo DevOps y los grupos de Desarrollo G04 y G13, en
> orden cronológico. El mismo texto está en `devops/bitacora.md` de los dos repos y en el informe
> del equipo.
>
> Cada entrada registra: fecha · responsable/s · módulo · objetivo · tarea ejecutada ·
> decisiones/acuerdos con Desarrollo · repositorio/issue/PR · evidencia · resultado ·
> dificultad o bloqueo · siguiente acción.

## Diagnóstico y avances

### 27/10/2026 - Visualización de repositorios y escenario

- Se analizó el escenario propuesto para el equipo de DevOps en primer lugar, para el
  entendimiento de las tareas a realizar y los lineamientos a tener en cuenta.
- Se analizó el escenario propuesto en Desarrollo de Software luego, para entender el trabajo que
  ya se encontraban realizando los dos equipos asignados.
- Primer acercamiento a cada equipo: se visualizaron los repositorios, las tecnologías que utiliza
  cada uno y los integrantes que conforman cada uno.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04 y G13) |
| Objetivo | Entender el escenario de DevOps y de Desarrollo y conocer a los dos equipos asignados |
| Decisiones/acuerdos | Todavía ninguno: primer acercamiento a los equipos |
| Repositorio/issue/PR | Repositorios de G04 y G13 (solo lectura) |
| Evidencia | Consigna del TP Integrador y escenario de Desarrollo de Software |
| Resultado | Repositorios, tecnologías e integrantes de cada equipo identificados |
| Dificultad o bloqueo | Ninguno |
| Siguiente acción | Evaluar el estado de cada equipo antes de la reunión del 05/11 |

### 03/11/2026 - Evaluación previa a la primer reunión

- Antes de la reunión establecida por la cátedra el 05/11/2026, se analizó el estado de situación
  y de avance de cada equipo, para entender y estar a la par con sus requerimientos.
- Las dos implementaciones que tienen los grupos: G04 en Node/Express/Prisma, del consorcio A
  (grupos 1-8). G13 en Python/FastAPI/SQLAlchemy, del consorcio B (grupos 9-17).
- Nuestro alcance: enfocarnos solo en M5 (solicitud y despacho) y en los dos equipos asignados.
  Tener en cuenta lo referido al despliegue, CI/CD, observabilidad y monitoreo, y ayudarlos con el
  desarrollo cuando lo necesiten.
- Requisitos no funcionales de la cátedra que debemos tener en cuenta en base a nuestra función en
  el trabajo intercátedra: RNF-04 (imágenes versionadas), RNF-06 (secretos fuera del repo), RNF-14
  (health y logs), RNF-16 (meta de performance), RNF-17 (CI) y RNF-18 (portabilidad a cloud).

Stack tecnológico:

| Aspecto | G04 (Node/Express/Prisma) | G13 (Python/FastAPI/SQLAlchemy) |
|---|---|---|
| ¿Se puede desplegar? | No todavía, tiene tres piezas sueltas, sin punto de entrada (`src/main.js` es pseudocódigo) ni `package.json` raíz | Sí, una sola API |
| Docker | Solo MySQL, con la contraseña escrita en el compose | Dockerfile + compose |
| Esquema de DB | `prisma db push`, esquemas sin unificar | `crear_tablas.py`, sin migraciones |
| Health | `/health` y `/health/ready` | No tiene todavía |
| Logs | JSON con id de request y solicitud | Ninguno por el momento |
| Llamadas a otros módulos | Timeout, reintentos e idempotencia | Todavía no hay |
| Tests | Con fakes en memoria | Con SQLite |
| CI | Todavía no hay | Todavía no hay |

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04 y G13) |
| Objetivo | Llegar a la reunión del 05/11 con el estado de situación de cada equipo |
| Decisiones/acuerdos | Alcance del equipo: sólo M5 y los dos equipos asignados. RNF a cubrir: RNF-04, RNF-06, RNF-14, RNF-16, RNF-17 y RNF-18 |
| Repositorio/issue/PR | Repositorios de G04 y G13 (solo lectura) |
| Evidencia | Tabla de stack tecnológico de esta entrada |
| Resultado | G13 se puede desplegar pero no tiene health ni logs; G04 tiene health y logs pero todavía no se puede desplegar; ninguno tiene CI |
| Dificultad o bloqueo | G04 sin punto de entrada ni `package.json` raíz |
| Siguiente acción | Reunión con los grupos del 05/11 |

### 05/11/2026 - Reunión presencial entre equipos

- Se habló de lo entendido por nosotros, de qué tenían los equipos hasta el momento y qué faltaba.
  También se mencionó cómo implementan funcionalidades que nos interesaban para posibles métricas.
- Se habló de posibles métricas que se podían considerar, de forma muy general y sin entrar en
  detalle, la idea fue tener una base, teniendo en cuenta las implementaciones de los
  requerimientos.
- Se formó un grupo de WhatsApp para comunicación y coordinación entre grupos. Se acordó continuar
  en primer lugar definiendo las métricas a tener en cuenta, y aspectos en el flujo de trabajo
  donde debería ayudar el equipo de DevOps.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04 y G13) |
| Objetivo | Poner en común el estado de cada equipo y empezar a coordinar el trabajo entre Desarrollo y DevOps |
| Decisiones/acuerdos | Grupo de WhatsApp como canal de coordinación entre los grupos. Primero se definen las métricas, junto con los aspectos del flujo de trabajo donde debe ayudar DevOps |
| Repositorio/issue/PR | — |
| Evidencia | Reunión presencial establecida por la cátedra |
| Resultado | Base general de métricas posibles según cómo cada grupo implementa los requerimientos |
| Dificultad o bloqueo | Ninguno |
| Siguiente acción | Relevar en detalle los repos y armar la propuesta de métricas |

### 20/11/2026 - Relevamiento verificado de los repositorios y propuesta de métricas

- Se clonaron los repositorios de G04 y G13 y el repositorio de la cátedra (`FRRe-DS/2026-TPI`) y se verificó
  cada punto del diagnóstico contra el código, separando lo verificado de lo inferido y de lo
  pendiente de confirmar.
- Se confirmó en los dos repositorios una condición de carrera en la cancelación: se lee el estado y
  después se escribe sin condición, por lo que una aceptación simultánea puede dejar una solicitud
  cancelada con conductor asignado.
- Se confirmó que los tests de concurrencia de los dos grupos no corren contra MySQL real, así que
  no prueban de verdad la asignación única (RNF-08).
- G04: dependencias usadas en el código sin declarar en ningún `package.json` y estados con nombres
  distintos según el archivo. G13: `requirements.txt` en UTF-16 y un compose que no espera a que
  MySQL esté listo.
- El contrato OpenAPI de M5 del repositorio de la cátedra está vacío; se tomaron como referencia los
  contratos de M4, M6 y M9.
- Se armó la propuesta de las tres métricas propias del módulo (tiempo hasta la asignación, tasa de
  asignación y tasa de aceptación de las ofertas) y de los indicadores técnicos, para discutirla con
  los dos grupos.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04 y G13) |
| Objetivo | Tener un diagnóstico verificado y una propuesta de métricas para acordar con Desarrollo |
| Decisiones/acuerdos | Gestionar G04 y G13 con un mismo contrato de observabilidad y CI |
| Repositorio/issue/PR | Sin cambios en los repositorios (solo lectura) |
| Evidencia | Documento de relevamiento y documento de propuesta de métricas del equipo DevOps |
| Resultado | Hallazgos con archivo y línea, matriz de brechas y backlog por repositorio |
| Dificultad o bloqueo | Contrato de M5 vacío en el repositorio de la cátedra; G04 todavía no se podía desplegar |
| Siguiente acción | Enviar la propuesta de métricas a los grupos |

### 26/11/2026 - Actualización de los repositorios y plan del Hito 2

- G04 pasó a ser desplegable: `package.json` en la raíz, `npm start` levanta el servicio completo,
  tiene `/health` y `/health/ready` y el despacho funciona de punta a punta (M4 → tandas de ofertas
  a M3 → M6), con avisos a M8 y M9. Corrigió la condición de carrera de la cancelación y unificó los
  estados.
- G04: pasan 149 de 164 tests. Las 15 fallas parecen tests desfasados por el cambio de contrato con
  M3, M4 y M8 (a confirmar con G04). Se detectaron secretos commiteados en los `.env.example`.
- G13 sumó la búsqueda de candidatos en M4 (RF-5.3) y las ofertas con vencimiento (RF-5.4). Ya emite
  la Métrica 3 propuesta (`m5.ofertas.finalizadas`), aunque todavía sin el SDK de OpenTelemetry que
  la exporte.
- G13: el cambio del modelo de ofertas dejó roto aceptar y rechazar en `main`. Pasan 36 de 47
  tests; caen los de RF-5.5 y los de asignación única (RNF-08). Existe una branch feature/rf-5.5-aceptar-rechazar-ofertas, que aparentemente podría arreglar esto.
- Se armó el plan del Hito 2: CI en los dos repositorios con el mismo workflow, contrato mínimo con health
  y logs, OpenTelemetry con tablero preliminar, y después VM, CD y k6.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04 y G13) |
| Objetivo | Actualizar el diagnóstico y planificar el Hito 2 |
| Decisiones/acuerdos | Propuesta de métricas enviada a los grupos; G13 ya implementó `m5.ofertas.finalizadas`. Equipo DevOps: arrancar el CI por G13, E2E con k6 y SAST con CodeQL |
| Repositorio/issue/PR | Sin cambios en los repositorios (solo lectura) |
| Evidencia | G04 `2d4634d`: 149/164 tests en verde. G13 `199b418`: 36/47 tests en verde |
| Resultado | G04 desplegable y con la cancelación corregida; G13 con RF-5.3/5.4 y el flujo de ofertas roto en `main` |
| Dificultad o bloqueo | Secretos commiteados en G04; flujo de ofertas roto en G13; permisos en G04 sin confirmar (solo lectura) |
| Siguiente acción | Pipeline de CI en G13 |

## Instrumentación y CI

### 26/11/2026 - Pipeline de CI en G13

- Se armó el workflow `.github/workflows/ci.yml` en la branch `devops/ci` del repositorio de G13. Se
  dispara al abrir o actualizar un PR hacia `main`, en cada push a `main` y a mano.
- Tiene seis jobs, con los mismos nombres que va a tener el de G04: `build`, `unit-tests`, `e2e`,
  `sast`, `secrets` y `docker`.
- `unit-tests`: corre `pytest` y publica en la ejecución un resumen con los totales y los tests que
  fallan, más el reporte JUnit como artefacto.
- `e2e`: levanta la app con MySQL 8.4 real y un mock de M4 (WireMock) armado desde el contrato
  oficial, y recorre cuatro flujos con k6: solicitud con búsqueda de candidatos, sin
  disponibilidad, M4 caído y cancelación previa.
- `sast`: CodeQL con el conjunto `security-extended` y un Quality Gate que bloquea las alertas
  altas y críticas.
- `secrets`: gitleaks sobre el árbol actual y sobre los commits nuevos del PR. Probado también sobre
  el repositorio de G04: detecta 6 secretos en el árbol actual y 7 en el historial, lo que confirma el
  hallazgo de los `.env.example`.
- `docker`: build de la imagen con el Dockerfile actual, sin publicarla.
- Se probó todo localmente antes de abrir el PR: el E2E pasó 30 de 30 verificaciones contra MySQL
  real, y con el mock de M4 apagado falló como corresponde.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G13) |
| Objetivo | Tener CI en el repositorio de G13 con build, unitarios, E2E, SAST y escaneo de secretos |
| Decisiones/acuerdos | E2E con k6, para reutilizarlo como base de las pruebas de carga. SAST con CodeQL. Quality Gate: bloquean las alertas altas y críticas. Los cambios de DevOps van en `devops/` y `.github/`, sin tocar la lógica del módulo |
| Repositorio/issue/PR | G13, branch `devops/ci` (PR a abrir) |
| Evidencia | E2E local: 30/30 verificaciones en verde; con M4 apagado, k6 termina con error (exit 99). Tests unitarios: 36/47 |
| Resultado | Pipeline listo para el PR. El job `unit-tests` va a quedar en rojo por los 11 tests rotos que ya están en `main`, no por este cambio |
| Dificultad o bloqueo | El E2E todavía no puede cubrir la aceptación concurrente (RNF-08) porque esa parte está rota en `main` |
| Siguiente acción | Abrir el PR en G13, abrir un issue por los tests rotos, sumar la aceptación concurrente al E2E cuando se mergee RF-5.5 y replicar el pipeline en G04 |

### 27/11/2026 - Política de tests y actualización del CI de G13 a RF-5.1

- G13 mergeó en `main` RF-5.1 (solicitud inmediata): las rutas pasan a `/api/v1`, crear una
  solicitud exige un token de M1 (Keycloak), consulta a M2 el estado de cuenta, avisa a M8 y
  dispara sola la búsqueda en M4. También mergeó un módulo de observabilidad con las tres métricas
  propuestas por DevOps, `/health` y `/health/ready`, y corrigió el `requirements.txt`.
- Con esos cambios, en `main` pasan 38 de 62 tests. Fallan 24 por dos motivos: 11 porque el código
  de aceptar y rechazar ofertas está roto, y 13 porque los tests quedaron desactualizados frente a
  las rutas nuevas y la autenticación.
- La branch `feature/rf-5.5-aceptar-rechazar-ofertas` de G13 arregla las 11 fallas del código
  (corrida sola pasa 53 de 53 tests), pero tiene conflictos con el `main` actual en `app/main.py`,
  `app/models/solicitud.py` y `tests/test_main.py`.
- Se definió la política de tests: por ser la primera vez, DevOps arregla los tests desactualizados
  para dejar una línea base en verde, sin abrir issues. A partir de ahí, cada test que se rompa con
  una funcionalidad nueva se reporta como issue al grupo dueño.
- Las fallas del código de la app no las arregla DevOps: se le pide a G13 que mergee su branch de
  RF-5.5. Los tests desactualizados de `test_main.py` y `test_rf_5_2_reserva.py` se arreglan después
  de ese merge, porque esa branch reescribe los mismos archivos.
- Se arreglaron los 5 tests desactualizados de `test_rf_5_3.py` (búsqueda de candidatos): se
  actualizaron las rutas a `/api/v1` y la solicitud de prueba se crea directo en la base, sin pasar
  por RF-5.1. Pasan los 13 tests de búsqueda.
- Se actualizó el E2E: mocks de M1, M2, M4 y M8 según los contratos oficiales, y tokens de prueba
  firmados con una clave que se genera en cada corrida y se descarta al terminar. Ahora recorre cinco
  flujos con 45 verificaciones: solicitud inmediata (autenticación, idempotencia y llamadas a M2, M8
  y M4), solicitud desde reserva con búsqueda de candidatos, sin disponibilidad, M4 caído y
  cancelación previa.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G13) |
| Objetivo | Adaptar el CI a los cambios de G13 y definir cómo se tratan los tests rotos |
| Decisiones/acuerdos | Política de tests: la primera vez DevOps arregla los tests desactualizados y deja la línea base en verde; desde ahí, cada regresión es un issue para el grupo. G13 mergea su branch de RF-5.5 para arreglar el código de ofertas |
| Repositorio/issue/PR | G13, PR #14 (https://github.com/FRRe-DS/2026-13-TPI/pull/14), branch `devops/ci`, commit `7afbcd4` |
| Evidencia | Primera ejecución del CI (https://github.com/FRRe-DS/2026-13-TPI/actions/runs/46090534488): `build`, `e2e`, `sast`, `secrets` y `docker` en verde; CodeQL sin alertas nuevas; `unit-tests` en rojo con 19 fallas ya existentes en `main` (43/62 pasan; antes del arreglo, 38/62). `test_rf_5_3.py`: 13/13. Branch RF-5.5 sola: 53/53 |
| Resultado | G13 ya implementó las tres métricas y los health checks. E2E al día con RF-5.1. Quedan 19 fallas: 11 del código de ofertas y 8 tests que se arreglan después del merge de RF-5.5 |
| Dificultad o bloqueo | Branch RF-5.5 con conflictos contra `main`. Hallazgos para G13: una solicitud inmediata no se puede cancelar, porque la búsqueda automática la saca de `PENDIENTE` enseguida; `desde-reserva` y `cancelar` no piden autenticación; M4 se configura con dos variables distintas (`M4_URL` y `M4_BASE_URL`) |
| Siguiente acción | G13 mergea RF-5.5. DevOps arregla los 8 tests restantes, suma la aceptación concurrente al E2E y abre el PR del CI |

### 27/11/2026 - Pipeline de CI en G04

- Se confirmó que el equipo tiene permisos de administrador en el repositorio de G04 (hasta ahora
  figuraba como solo lectura), así que se trabaja con una branch `devops/ci` en el mismo
  repositorio, sin fork.
- En `main` de G04 pasan 154 de 170 tests. Se revisó cada una de las 16 fallas contra el código y su
  historial, y ninguna es un error de la app:
  - 7 de los avisos a M3, M4 y M6: cambió el formato de los avisos y los tests no se actualizaron.
    El cuerpo hacia M4 sigue el contrato oficial; el de M3 es un contrato acordado en el consorcio,
    que no está en el repositorio de la cátedra.
  - 3 que esperaban un solo aviso a M6: desde el 25/11, al repetir una aceptación M5 vuelve a llamar
    a M6 para recuperar el `tripId` que necesita M3, con la misma clave de idempotencia (M6 no
    duplica el viaje).
  - 1 del outbox de M8: se sacó el `conductorId` del evento porque el contrato oficial de M8 no
    admite campos extra.
  - 4 de seguridad (3 de ellas en cadena): ahora solo M3, con su permiso de servicio, puede
    responder ofertas, y los tests seguían armando el router con el modelo anterior.
  - 1 por el nombre de un archivo: `src/clientes/ClienteM8.js` se importaba como `clienteM8`. En
    Windows funciona, pero en Linux no, por eso solo lo detecta un CI.
- Siguiendo la política de tests del 27/11, DevOps actualizó los tests y renombró el archivo. Los
  tests de seguridad pasaron al modelo real sin perder lo que protegen: siguen verificando que sin
  el permiso de M3 o con una oferta ajena la respuesta es 403. Pasan los 171 tests.
- Se agregó el script `npm test` y el workflow `.github/workflows/ci.yml` con los jobs `build`,
  `unit-tests`, `sast` (CodeQL para JavaScript) y `secrets` (gitleaks), con la misma estructura que
  el de G13.
- gitleaks encuentra 6 hallazgos en el código actual: 3 son falsos positivos (valores de relleno y
  un test), que se excluyeron en `devops/ci/gitleaks.toml`, y 3 son secretos reales en los
  `.env.example`. El job `secrets` queda en rojo hasta que G04 los rote.
- `e2e` y `docker` van en un segundo PR: G04 no tiene Dockerfile, y el E2E necesita aplicar su
  esquema de Prisma sobre MySQL, un reemplazo de Keycloak y mocks de M3, M4, M6, M8 y M9.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04) |
| Objetivo | Tener CI en el repositorio de G04 con la misma estructura que en G13 |
| Decisiones/acuerdos | Branch en el repositorio de G04 (permisos de administrador confirmados). Política de tests aplicada: DevOps actualiza los tests desfasados. Los secretos reales no se excluyen: el job falla hasta que G04 los rote. CI en dos PR: primero build, unitarios, SAST y secretos; después E2E y Docker |
| Repositorio/issue/PR | G04, PR #1 (https://github.com/FRRe-DS/2026-04-TPI/pull/1), branch `devops/ci`, commit `52dae04` |
| Evidencia | Primera ejecución del CI (https://github.com/FRRe-DS/2026-04-TPI/actions/runs/46096149746): `build`, `unit-tests` (171/171; en `main`, 154/170) y `sast` en verde; CodeQL sin alertas nuevas; `secrets` en rojo por los 3 secretos reales (`.env.example:65`, `front/.env.example:8` y `:11`), de 6 hallazgos |
| Resultado | Línea base de tests en verde en G04. Pipeline listo para el PR, con `secrets` en rojo por los secretos commiteados |
| Dificultad o bloqueo | Los secretos están en el historial de git: además de reemplazarlos hay que rotarlos. El contrato con M3 no se puede validar contra el repositorio de la cátedra |
| Siguiente acción | Abrir el PR en G04, pedirle a G04 que rote los secretos y armar el segundo PR con E2E y Docker |

### 28/11/2026 - E2E y Docker en G04: el despacho no podía asignar

- Se aplicó por primera vez el esquema de Prisma de G04 sobre un MySQL real (`prisma db push`): se
  crearon las 8 tablas sin errores.
- Se armaron los mocks que faltaban para levantar G04 completo: M3 (envío de ofertas y datos del
  conductor, contrato acordado en el consorcio A), M4 (estimación de ruta y reserva), M6 (creación
  del viaje) y M7 (tarifa), según los contratos oficiales donde existen. Los mocks son los mismos
  archivos en los dos repositorios; también se corrigieron los de M4, que exigían un encabezado
  `X-Request-Id` que el contrato oficial declara opcional.
- Se escribió el E2E de G04 con k6: solicitud inmediata (las mismas verificaciones que en G13),
  despacho (candidatos de M4, reserva en M4 y ofertas por M3), asignación única con dos
  aceptaciones simultáneas (RNF-08), sin disponibilidad y cancelación previa.
- **Hallazgo:** el E2E encontró un error de la app que los tests unitarios no detectan. La
  solicitud nunca pasa de `pendiente` a `buscando` cuando empieza el despacho: la función que lo
  hace existe (`solicitudes.iniciarBusqueda`, `src/main.js:177-181`) pero `iniciarDespacho`
  (`src/ofertas/despacho.js`) nunca la llama. Como aceptar exige que la solicitud esté en
  `buscando`, **ninguna aceptación puede asignar un conductor** (las dos reciben 409) y la búsqueda
  sin candidatos tampoco puede cerrar en `sin_disponibilidad`. La función existe desde el 23/11 y
  nunca se llamó: no es una regresión.
- Para confirmar que el E2E está bien escrito, se corrió contra una copia descartable de la app con
  esa llamada agregada (solo dentro de un contenedor local, sin tocar el repositorio): pasaron las
  35 verificaciones.
- Se agregó un `Dockerfile` en dos etapas (usuario sin privilegios y `HEALTHCHECK` sobre `/health`)
  y los jobs `e2e` y `docker` al CI, con lo que el workflow de G04 queda con los mismos seis jobs
  que el de G13. La imagen se probó localmente: queda sana y el E2E da el mismo resultado contra
  ella.
- Antes de abrir el PR, GitHub marcó conflictos con `main`: entre el 27 y el 28/11 G04 había
  mergeado varios cambios. Arregló su suite de tests en paralelo y agregó su propio `npm test`
  (commit `2098401`). También corrigió el error del despacho por su cuenta, antes de que se le
  informara (commit `050ebda`), y movió la consulta de ofertas a `/api/v1`.
- Se incorporó `main` a las dos branches de DevOps (merge, sin reescribir historia). En los tests
  y en `package.json` se adoptaron las versiones de G04 y se descartaron las de DevOps. El job
  `unit-tests` corre los mismos archivos que su `npm test`.
- Más tarde G04 borró `ClienteM8.js` y su test (commit `139ee82`): era código sin uso. Se aceptó el
  borrado en lugar del renombre, así que **el PR #1 ya no modifica código de G04**: solo agrega
  `devops/` y `.github/`. Con el `main` actualizado pasan los 207 tests.
- Contra el código actual de G04, el E2E pasa completo (35/35): queda confirmado con MySQL real
  que el arreglo funciona, incluida la asignación única con dos aceptaciones simultáneas. El
  adaptador de k6 se actualizó a la ruta nueva de ofertas. La ruta vieja
  (`GET /solicitudes/{id}/ofertas`) quedó respondiendo siempre 403; el frontend no la usa.
- gitleaks encontró en el proyecto de investigación que G04 subió al repositorio 2 falsos positivos
  (el encabezado `Sec-WebSocket-Key`, un valor aleatorio del protocolo WebSocket), que se excluyeron.
- Al actualizar el PR #1, el Quality Gate de SAST falló con 13 alertas altas, todas de la regla
  `js/missing-rate-limiting` y todas en `INVESTIGACIÓN/` (servicios `asientos` y `funciones` del
  proyecto de investigación). En `src/`, el código de M5, no hubo ninguna alta ni crítica: M5 ya
  limita la cantidad de pedidos con `express-rate-limit`. Se excluyó `INVESTIGACIÓN/` del análisis de
  CodeQL, porque el SAST cubre el módulo M5 y no otro trabajo práctico subido al mismo repositorio.
  gitleaks la sigue revisando.

| Campo | Detalle |
|---|---|
| Responsable/s | Fidanza, Felipe · Jerez, Fabricio E. · Urturi, Renzo O. |
| Módulo | M5 (G04) |
| Objetivo | Completar el CI de G04 con E2E y Docker |
| Decisiones/acuerdos | El E2E verifica el comportamiento correcto aunque falle: el error de despacho es de lógica funcional y lo corrige G04 (lo hizo el mismo día, en `050ebda`). Ante el conflicto con `main` se adoptan los tests de G04, que son los dueños. El SAST analiza solo el código de M5 (`INVESTIGACIÓN/` excluida de CodeQL). Mocks y scripts compartidos idénticos en los dos repositorios |
| Repositorio/issue/PR | G04, PR #2 (https://github.com/FRRe-DS/2026-04-TPI/pull/2), branch `devops/e2e`, y PR #1 actualizado con `main` (commit `50dbf2e`). G13, PR #14 (branch `devops/ci`): mocks y script de tokens actualizados |
| Evidencia | E2E local de G04 antes del arreglo: 25/29 (las 4 que fallan son las del error de despacho); con la llamada agregada en una copia descartable: 35/35; contra el `main` actual de G04 (`990310f`): 35/35, también contra la imagen Docker. Tests de G04 con `main` incorporado: 207/207. CI del PR #2 (https://github.com/FRRe-DS/2026-04-TPI/actions/runs/46178238076): `build`, `unit-tests`, `e2e`, `sast` y `docker` en verde; `secrets` en rojo por los secretos de G04. CI del PR #1 actualizado (https://github.com/FRRe-DS/2026-04-TPI/actions/runs/46177727061): `sast` en verde con `INVESTIGACIÓN/` excluida. E2E de G13 con los mocks compartidos: 45/45. Imagen de G04: `healthy`, usuario `node` |
| Resultado | CI de G04 con los seis jobs y el E2E en verde. El error de despacho quedó detectado, localizado y corregido |
| Dificultad o bloqueo | Cambios de G04 en paralelo generaron conflictos con los PR abiertos. La imagen pesa ~800 MB porque el CLI de Prisma queda instalado: hay que achicarla antes del despliegue |
| Siguiente acción | Que G04 rote los secretos y mergee los PR #1 y #2; avisarle de la ruta vieja de ofertas |

## Carga y cierre
