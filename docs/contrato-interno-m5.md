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

Supuestos a confirmar con el grupo: que el rechazo avise a M4 con `liberarConductores` (motivo `oferta_rechazada`), y las rutas de aviso de M4 y M6.

## 7. Contrato con M4 (propuesta del grupo, a validar con M4)

**Supuesto de trabajo:** M4 reserva temporalmente a los conductores que devuelve en la lista. La reserva es
asunto interno de M4: M5 no tiene una llamada de "reservar".

Los cuerpos hacia M4 van en `snake_case` y los ids son `string` (uuid). La traducción desde `camelCase` se hace
solo en `src/asignacion/notificaciones.js` y `src/busqueda/busquedaService.js`.

### 7.1 Búsqueda de candidatos (`src/busqueda/busquedaService.js`, `POST {M4_URL}/buscar`)

Una llamada por solicitud. El radio lo decide M4 (radio inicial y ampliación según los conductores disponibles);
M5 no manda radio, límite ni exclusiones, y tampoco filtra por radio.

| M5 → M4 | Tipo |
|---|---|
| `solicitud_id` | string (uuid) |
| `origen_latitud`, `origen_longitud` (del cliente) | real |
| `destino_latitud`, `destino_longitud` (del cliente) | real |

| M4 → M5 | Tipo |
|---|---|
| `candidatos[]` con `conductor_id` (el mismo uuid que maneja M3) | string (uuid) |
| `distancia_m` | real |
| `tipo_vehiculo` | string |

- **Lista vacía = "no hay conductores".** Es una respuesta válida y no se reintenta.
- **Error, timeout o respuesta sin `candidatos[]`: se repite el intento** (3 intentos con espera creciente). Si
  sigue fallando se lanza `ErrorBusquedaCandidatos`; **nunca** se toma como lista vacía ni se declara agotada.
- M5 ordena por `distancia_m` (menor a mayor), filtra por `tipo_vehiculo` (el pedido lo trae la solicitud),
  descarta candidatos sin `conductor_id` y se queda con la menor distancia si un conductor viene repetido.
- Las coordenadas se validan antes de llamar a M4: latitud entre -90 y 90, longitud entre -180 y 180.

### 7.2 Liberar conductor (`notificaciones.liberarConductores`)

| M5 → M4 | Tipo |
|---|---|
| `conductor_id` | string (uuid) |
| `solicitud_id` | string (uuid) |
| `oferta_id` | string (uuid) |
| `motivo` | `oferta_rechazada`, `oferta_vencida`, `solicitud_cerrada` (otro ganó) o `cancelada_por_cliente` |

- Una llamada por conductor, con `Idempotency-Key: liberar:{ofertaId}`. M5 no manda un motivo que M4 no conozca.
- Dónde se usa cada motivo: rechazo → `oferta_rechazada`; job de vencimientos → `oferta_vencida`; los perdedores
  cuando otro conductor gana → `solicitud_cerrada`; cancelación del cliente → `cancelada_por_cliente`.
- Respuesta esperada de M4: 200/204, también si el conductor ya estaba libre (repetir no da error).

### 7.3 Conductor seleccionado (`notificaciones.conductorSeleccionado`)

Se manda una sola vez, después de confirmar la asignación, y **al ganador no se le manda "liberar"**.

| M5 → M4 | Tipo |
|---|---|
| `solicitud_id` | string (uuid) |
| `conductor_id` | string (uuid) |
| `oferta_id` | string (uuid) |

- Header `Idempotency-Key: seleccion:{solicitudId}:{conductorId}`.
- M4 → M5: 200 si el conductor queda ocupado; 4xx si por alguna razón ya no está disponible.
- Un 4xx no deshace la asignación (ya está confirmada): queda en `avisosFallidos` como `conductorSeleccionado` y
  se registra en el log para revisarlo.

### 7.4 Pendiente

- **Liberar a los candidatos que nunca recibieron oferta.** Si M4 reserva a toda la lista, al cerrar la búsqueda
  (asignación, agotada o cancelación) habría que liberar también a esos conductores. Hoy `Busqueda` solo guarda
  `candidatosRestantes` (un número): haría falta guardar la lista de `conductor_id` y que `oferta_id` sea opcional
  en la liberación. **No está implementado**; mientras tanto conviene que M4 libere solo las reservas pasado un tiempo máximo.
- Autenticación entre servicios (token de M1 u otro) y rutas finales de M4: `notificaciones.js` las recibe por
  parámetro (`rutas.m4LiberarConductor`, `rutas.m4ConductorSeleccionado`) y no tienen valor por defecto.

### 7.5 Reglas comunes

`Idempotency-Key` en todo lo que no sea GET · timeout 3 s y reintentos acotados (`clienteHttp`) · errores con el
formato común `{ error: { codigo, mensaje } }` · fechas ISO-8601 UTC.
