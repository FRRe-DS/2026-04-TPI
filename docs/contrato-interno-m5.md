# Contrato interno M5 — Asignación única y búsqueda agotada (Vale, B2)

Este documento dice qué espera mi parte de las demás (A, Martin, Lautaro, Azul) y qué entrega.
Todo está pensado para **un solo servicio/repositorio**: A y B se llaman por funciones, no por HTTP.
(Pendiente de confirmar con A. Si resultara ser más de un servicio, los puertos de abajo pasan a ser clientes HTTP y no cambia nada más.)

## 1. Qué entrega mi parte

| Carpeta | Qué es | Quién lo usa |
|---|---|---|
| `src/comun/` | Middleware JWT/roles, validación (zod), `/health`, logs con `solicitudId`, errores, cliente HTTP con timeout/reintentos, enums de estados compartidos | Todos |
| `src/asignacion/procesarAceptacion.js` | RF-5.6: asignación única (transacción + escritura condicional) | Azul (endpoint de respuesta) |
| `src/asignacion/procesarCancelacion.js` | Reacción de B cuando A cancela una solicitud | A (flujo de cancelación) |
| `src/asignacion/busquedaAgotada.js` | RF-5.8: detecta agotada y avisa a A una sola vez | Lautaro (rondas) y Azul (job de vencimientos) |
| `tests/` | RNF-07 (concurrencia), seguridad, cliente HTTP | Revisión cruzada (Lautaro) |

Ejemplo de uso completo del endpoint: `tests/soporte/routerEjemplo.js`.

## Encaje con la estructura de carpetas del grupo

```
m5/
  docs/        contrato-interno-m5.md (este), variables-entorno-seguridad.example
  prisma/      schema.prisma                 (Persona 3, no lo toco)
  src/
    busqueda/  candidatos y ranking          (Persona 1)
    clientes/  ClienteM3M4                   (Persona 1)
    ofertas/   envío, TTL, Redis             (Persona 2)
    respuesta/ responder oferta              (Persona 3)  <- usa mis piezas
    asignacion/ asignación y agotada         (Persona 4, mío)
    comun/     auth, errores, config         (Persona 4, mío)
  tests/       asignacion/  comun/  soporte/
```

Notas: `src/comun/clienteHttp.js` es un cliente genérico (timeout + reintentos) que usan mis avisos;
`ClienteM3M4` de Martin va en `src/clientes/` y puede apoyarse en él. `src/asignacion/esquemas.js` y
`autorizacionOferta.js` los consume el endpoint de `src/respuesta/` (Azul). El `.env.example` es de
Martin: las variables de seguridad están en `docs/variables-entorno-seguridad.example` para copiarlas ahí.

## 2. Puertos que necesito (lo que A y B tienen que implementar)

Todas las funciones que escriben reciben `tx` (la transacción actual) como último argumento.
Los nombres exactos y las firmas están en `src/asignacion/puertos.js`.

**De A (solicitud / eventos)**
- `solicitudes.obtenerEstado(solicitudId, tx?)` → `{ estado, conductorAsignadoId }` o `null`
- `solicitudes.asignar({ solicitudId, conductorId }, tx)` → `{ resultado }` con el detalle completo: `asignada`, `ya_asignada`, `solicitud_cancelada`, `solicitud_no_buscando` o `solicitud_inexistente` (valores de `ResultadoPuertoAsignacion`). Nosotros lo simplificamos a los 5 códigos de la sección 4; A no tiene que conocerlos. **Tiene que ser `UPDATE ... WHERE estado = 'BUSCANDO'` y mirar las filas afectadas.** Es la pieza que garantiza la asignación única.
- `solicitudes.marcarSinDisponibilidad({ solicitudId, motivo }, tx)` → `{ aplicado, estadoActual }`, también condicional a `buscando`.
- `eventos.registrar({ solicitudId, tipo, conductorId?, ofertaId?, ocurridoEn, detalle? }, tx)`

**De B (ofertas / búsqueda)**
- `ofertas.obtenerPorId` → `{ ofertaId, solicitudId, conductorId, estado, venceEn }` o `null`
- `ofertas.aceptar({ ofertaId, conductorId, ahora }, tx)` → `{ aceptada }` (condicional: `pendiente`, vigente y del conductor)
- `ofertas.cancelarPendientesDeSolicitud({ solicitudId, exceptoOfertaId? }, tx)` → `[{ ofertaId, conductorId }]` (las que canceló)
- `ofertas.contarPendientes(solicitudId)` → número
- `busquedas.obtenerActiva(solicitudId)` → `{ busquedaId, venceEn, candidatosRestantes }` o `null`
- `busquedas.cerrar({ solicitudId, estado }, tx)` → `true` si la cerró (condicional: solo si estaba `activa`)

**Infra**
- `ejecutarEnTransaccion(fn)` (en Prisma: `prisma.$transaction`), `cacheOfertas.eliminar`, `notificaciones`, `reloj`, `logger`.

## 3. Reglas que tienen que respetar todos

1. **Orden de locks: solicitud → ofertas → búsqueda.** Si alguien actualiza en otro orden dentro de una transacción, aparecen deadlocks. Mi código reintenta ante deadlock, pero no hay que depender de eso.
2. **Ningún aviso externo (Redis, M4, M6) dentro de la transacción.** Se hacen después del commit; si fallan, se informan en `avisosFallidos` y no deshacen la asignación.
3. **Estados:** usar los enums de `src/comun/estados.js`. No definir strings sueltos (`"Buscando"` vs `"buscando"` ya rompió cosas en el repo). Los valores van en snake_case minúscula (`buscando`, `sin_disponibilidad`); los códigos de resultado de la API (`ASIGNADA`, `RECHAZADA`, ...) siguen en mayúscula porque no son estados.
4. **Condicionales siempre:** cambiar estado con `WHERE estado = <esperado>` y mirar filas afectadas. Nunca leer y después escribir.
5. **Un endpoint = rol + validación + dueño:** `requerirRol` → `validar` → `verificarConductorDeOferta` → lógica.

## 4. Resultados posibles de la aceptación (5 códigos)

| Resultado | HTTP | `motivo` | Significado |
|---|---|---|---|
| asignada | 200 | — | Este conductor quedó asignado (`repetida: true` si ya lo estaba) |
| solicitud_no_disponible | 409 | `ya_asignada` | Otro conductor ganó |
| | | `solicitud_cancelada` | El cliente canceló antes |
| | | `solicitud_no_buscando` | La solicitud ya no está buscando |
| | | `ya_aceptada` | (solo al rechazar) la oferta ya había sido aceptada |
| oferta_no_vigente | 410 | — | Vencida / cancelada / rechazada |
| no_encontrado | 404 | — | La oferta o su solicitud no existe |
| conductor_no_autorizado | 403 | — | La oferta es de otro conductor |

El `motivo` viaja en `error.motivo` y mantiene el detalle sin multiplicar códigos. En el endpoint,
"oferta inexistente" y "oferta de otro conductor" ya los corta antes `rutas.js` con el formato común
(`NO_ENCONTRADO` 404 / `PROHIBIDO` 403); `no_encontrado` y `conductor_no_autorizado` de esta tabla solo
salen si la oferta desaparece en medio del pedido o si se usa el caso de uso sin el router.

Alinear estos códigos con el catálogo de errores de Lautaro.

## 5. Preguntas abiertas

- **A:** ¿Mismo repo y mismo proceso? ¿Pueden exponer `asignar` y `marcarSinDisponibilidad` aceptando `tx` y como condicionales?
- **M1:** el token trae `identidad_id`, no `conductor_id`. ¿Viene un claim con el conductor o hay que consultarlo a M3? (`resolverConductorId` es enchufable.)
- **M4 / M6:** rutas y cuerpos para "liberar conductor" y "conductor asignado". En `notificaciones.js` quedan como parámetro `rutas`: **no las inventé**. Lo que M5 le manda y espera de M4 está en la sección 7.
- **M6:** RF-6.7 devuelve una solicitud a despacho (asignada → buscando). ¿Quién lo ejecuta? Es una función más de A.

## 6. Limitaciones conocidas

- Los tests de concurrencia usan fakes en memoria con un mutex global, que es **más estricto** que MySQL. Prueban la lógica (y detectan los errores que introduje a propósito), pero falta una prueba contra MySQL real (docker-compose de Martin) con N respuestas simultáneas.
- El parser JSON va después de la autenticación (no se parsean cuerpos de requests no autenticados).

## Respuesta del conductor (B2, `src/respuesta/`)

Qué hay y quién lo usa:

| Archivo | Qué hace |
|---|---|
| `rutas.js` | `POST /ofertas/:ofertaId/respuesta`. Orquesta: rol, validación, existencia, dueño, y llama a aceptar o rechazar. |
| `procesarRechazo.js` | Rechazo con idempotencia. Evento + escritura condicional en UNA transacción; avisos y búsqueda agotada después del commit. |
| `jobVencimientos.js` | Marca como VENCIDAS las ofertas cuyo plazo pasó, libera conductores y evalúa búsqueda agotada una vez por solicitud. |
| `repositorioOfertas.js` | Funciones de ofertas sobre Prisma (`aceptar`, `rechazar`, `cancelarPendientesDeSolicitud`, `contarPendientes`, `listarVencidas`, `vencer`) y `crearEjecutarEnTransaccion`. |
| `resultadosRespuesta.js` | Resultados propios del rechazo y su traducción a HTTP. |

Respuestas HTTP del endpoint:

| Caso | Código | `error.codigo` / `resultado` |
|---|---|---|
| Aceptó y ganó (o repite la misma aceptación) | 200 | `asignada` (`repetida` true/false) |
| Rechazó (o repite el rechazo) | 200 | `rechazada` (`repetida` true/false) |
| Otro conductor ya ganó | 409 | `solicitud_no_disponible` + `motivo: ya_asignada` |
| Quiso rechazar lo que ya aceptó | 409 | `solicitud_no_disponible` + `motivo: ya_aceptada` |
| La solicitud fue cancelada | 409 | `solicitud_no_disponible` + `motivo: solicitud_cancelada` |
| Oferta vencida, cancelada o ya rechazada | 410 | `oferta_no_vigente` |
| Oferta de otro conductor | 403 | `PROHIBIDO` |
| Oferta inexistente | 404 | `NO_ENCONTRADO` |
| Body inválido | 400 | `VALIDACION` |

Reglas que no se pueden romper:
1. Todo cambio de estado es una escritura condicional (`UPDATE ... WHERE estado = <esperado>`) y se mira cuántas filas cambió.
2. La vigencia se decide por la hora (`venceEn > ahora` dentro del WHERE); el job solo limpia.
3. Las escrituras reciben el `tx` de la transacción: con el cliente común quedarían fuera.
4. Dentro de la transacción: primero el evento, después la oferta (orden de bloqueos).
5. Avisos a Redis, M4 y M6 solo después del commit, con tiempo límite; si fallan, la respuesta no cambia.

El rechazo y el vencimiento liberan en M4 la reserva de ese conductor. Las rutas actuales se documentan
en las secciones siguientes y se configuran mediante los adaptadores de M5.

## 7. Contrato con M4 (propuesta del grupo, a validar con M4)

M4 devuelve candidatos sin reservarlos. M5 reserva a cada conductor individualmente antes de enviarle
una oferta y libera las reservas cuando corresponde.

Los cuerpos hacia M4 van en `snake_case` y los ids son `string` (uuid). La traducción desde `camelCase` se hace
solo en `src/asignacion/notificaciones.js` y `src/busqueda/busquedaService.js`.

### 7.1 Búsqueda de candidatos (`src/busqueda/busquedaService.js`, `GET {M4_URL}/api/v1/conductores/cercanos`)

Una llamada por solicitud. El radio lo decide M4 (radio inicial y ampliación según los conductores disponibles);
M5 no manda radio, límite ni exclusiones, y tampoco filtra por radio.

| M5 → M4 | Tipo |
|---|---|
| `origen_latitud`, `origen_longitud` (del cliente) | query, real |
| `tipo_vehiculo` | query, string |

| M4 → M5 | Tipo |
|---|---|
| `conductores[]` con `conductor_id` (el mismo uuid que maneja M3) | string (uuid) |
| `distancia_origen_km` | real, kilómetros |
| `tipo_vehiculo` | string |

- **Lista vacía = "no hay conductores".** Es una respuesta válida y no se reintenta.
- **Error, timeout o respuesta sin `conductores[]`: se repite el intento** (3 intentos con espera creciente). Si
  sigue fallando se lanza `ErrorBusquedaCandidatos`; **nunca** se toma como lista vacía ni se declara agotada.
- M5 conserva la distancia en kilómetros y ordena por `distancia_origen_km` (menor a mayor), filtra por `tipo_vehiculo` (el pedido lo trae la solicitud),
  descarta candidatos sin `conductor_id` y se queda con la menor distancia si un conductor viene repetido.
- Las coordenadas se validan antes de llamar a M4: latitud entre -90 y 90, longitud entre -180 y 180.

### 7.2 Reservar y liberar conductor (`notificaciones`)

| M5 → M4 | Tipo |
|---|---|
| Ruta | `POST /api/v1/conductores/{conductor_id}/reserva` |
| `estado_temporal` | `RESERVADO` para bloquear; `LIBERADO` para liberar |
| `solicitud_id` | string (uuid) |

- M5 reserva de a un conductor y solo crea ofertas para reservas confirmadas. La clave es
  `reservar:{solicitudId}:{conductorId}`; un conflicto 409 hace que M5 pruebe con el siguiente candidato.
- M5 libera con `Idempotency-Key: liberar:{solicitudId}:{conductorId}` y el mismo `solicitud_id` que reservó.
  Si se rechaza o vence una oferta, libera al conductor correspondiente; al cerrar la solicitud, libera
  a los demás reservados que sigan activos, incluido el ganador.

### 7.3 Creación del viaje tras la asignación (M3 y M6)

Después de que M5 confirma en su base al conductor ganador, consulta los datos del vehículo a M3 y crea
el viaje en M6. M5 conserva el `tripId` real que devuelve M6 y lo devuelve a M3 junto con `status`.

| Llamada | Contrato |
|---|---|
| M5 → M3 | `POST /api/v1/integration/drivers/dispatch-info`, cuerpo `{ conductor_id }` |
| M3 → M5 | `vehiculo.vehiculo_id` y `vehiculo.tipo_vehiculo` |
| M5 → M6 | `POST /trips`, `requestId`, `clientId`, `driverId`, `vehicleId`, tipo y coordenadas |

- M6 recibe `Idempotency-Key: viaje:{solicitudId}`; reintentar la aceptación recupera el mismo viaje.
- La ruta de creación de M6 es `/trips` y puede configurarse con `M6_RUTA_CREAR_VIAJE`.

### 7.4 Persistencia de distancia

M5 guarda `Candidato.distanciaKm` en kilómetros en el schema activo `bd/prisma/schema.prisma`. La base debe
recibir una migración compatible antes de desplegar esta versión; la carpeta raíz `prisma/` no forma parte
de este cambio y queda intacta.

### 7.5 Reglas comunes

`Idempotency-Key` en todo lo que no sea GET · timeout 3 s y reintentos acotados (`clienteHttp`) · errores con el
formato común `{ error: { codigo, mensaje } }` · fechas ISO-8601 UTC.
