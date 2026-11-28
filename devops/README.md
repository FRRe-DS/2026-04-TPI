# devops/ — aporte del equipo DevOps (Grupo 5) a M5 G04

Esta carpeta y `.github/workflows/ci.yml` son el aporte del equipo DevOps del TP Integrador
Intercátedra. **No modifican la lógica funcional del módulo**: agregan CI, análisis de seguridad
y la bitácora del trabajo conjunto. Todo cambio entra por Pull Request y lo revisa el grupo G04.

La misma estructura existe en el repo de G13 (consorcio B): los dos repos implementan M5 y se
gestionan con el mismo contrato, para poder comparar las dos implementaciones.

```
.github/workflows/ci.yml   pipeline de CI
devops/
├── bitacora.md            bitácora compartida DevOps <-> Desarrollo (igual en G04 y G13)
└── ci/
    ├── junit_summary.py   resumen de tests (JUnit) en la página de la ejecución (igual en G13)
    ├── sarif_gate.py      Quality Gate de SAST sobre los resultados de CodeQL (igual en G13)
    └── gitleaks.toml      reglas de gitleaks + falsos positivos revisados a mano
```

## Pipeline (`ci.yml`)

Se ejecuta al **abrir o actualizar un PR hacia `main`**, en cada **push a `main`** y a mano
(*Run workflow*).

| Job | Qué verifica | Si falla |
|---|---|---|
| `build` | `npm ci`, cliente de Prisma, sintaxis de `src/` y que `src/main.js` cargue | Bloquea `unit-tests` |
| `unit-tests` | `node --test` (fakes en memoria, como hoy). Publica el resumen y el reporte JUnit | Falla si algún test falla |
| `sast` | **CodeQL** (`javascript-typescript`, `security-extended`) + Quality Gate | Falla con alertas **altas o críticas** |
| `secrets` | **gitleaks** sobre el árbol actual y los commits nuevos | Falla si encuentra un secreto |

**Próximo PR:** `e2e` (la app con MySQL real y mocks de los módulos dependientes, recorrida con
k6) y `docker` (build de la imagen con un `Dockerfile` nuevo), igual que en G13.

Los resultados quedan en la pestaña *Actions*: el resumen de cada job y los artefactos (JUnit,
SARIF). Las alertas de CodeQL también aparecen en *Security → Code scanning*.

El job corre los mismos archivos que `npm test` (`tests/`, `src/**/*.test.js` y
`tests/TestSolicitud.js`), así que en local se prueban igual con `npm test`.

### Quality Gate de SAST

- **Bloquean** el PR las alertas con *security-severity* ≥ 7.0 (**altas** y **críticas**).
- Las **medias** y **bajas** se informan en el resumen sin bloquear.
- El umbral se cambia en un solo lugar: `--umbral` en el job `sast`.
- CodeQL analiza el código de M5. La carpeta `INVESTIGACIÓN/` (un proyecto de investigación aparte)
  queda fuera del análisis; gitleaks sí la revisa.

### Secretos

`devops/ci/gitleaks.toml` excluye solo falsos positivos revisados a mano: valores de relleno de los
archivos de ejemplo ("reemplazar…", "cambiar…"), los tokens falsos de
`tests/comun/seguridad.test.js` y el encabezado `Sec-WebSocket-Key` de la documentación del
proyecto de investigación (es un valor aleatorio del protocolo WebSocket, no un secreto).

**El job `secrets` falla hoy a propósito**: `.env.example` y `front/.env.example` tienen un
`INTERNAL_API_TOKEN` y un `KEYCLOAK_ADMIN_CLIENT_SECRET` reales (commit `20b617c`, 25/11). Hay que
**rotarlos** (generar valores nuevos donde se usen) y dejar en los `.env.example` valores de
ejemplo. Sacarlos del archivo no alcanza, porque siguen en el historial de git (RNF-06).
