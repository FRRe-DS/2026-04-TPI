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
- `solicitudes.asignar({ solicitudId, conductorId }, tx)` → `{ resultado }` con `ASIGNADA`, `YA_ASIGNADA`, `SOLICITUD_CANCELADA`, `SOLICITUD_NO_BUSCANDO` o `SOLICITUD_INEXISTENTE` (valores de `ResultadoAsignacion`). **Tiene que ser `UPDATE ... WHERE estado = 'BUSCANDO'` y mirar las filas afectadas.** Es la pieza que garantiza la asignación única.
- `solicitudes.marcarSinDisponibilidad({ solicitudId, motivo }, tx)` → `{ aplicado, estadoActual }`, también condicional a `BUSCANDO`.
- `eventos.registrar({ solicitudId, tipo, conductorId?, ofertaId?, ocurridoEn, detalle? }, tx)`

**De B (ofertas / búsqueda)**
- `ofertas.obtenerPorId` → `{ ofertaId, solicitudId, conductorId, estado, venceEn }` o `null`
- `ofertas.aceptar({ ofertaId, conductorId, ahora }, tx)` → `{ aceptada }` (condicional: `PENDIENTE`, vigente y del conductor)
- `ofertas.cancelarPendientesDeSolicitud({ solicitudId, exceptoOfertaId? }, tx)` → `[{ ofertaId, conductorId }]` (las que canceló)
- `ofertas.contarPendientes(solicitudId)` → número
- `busquedas.obtenerActiva(solicitudId)` → `{ busquedaId, venceEn, candidatosRestantes }` o `null`
- `busquedas.cerrar({ solicitudId, estado }, tx)` → `true` si la cerró (condicional: solo si estaba `ACTIVA`)

**Infra**
- `ejecutarEnTransaccion(fn)` (en Prisma: `prisma.$transaction`), `cacheOfertas.eliminar`, `notificaciones`, `reloj`, `logger`.

## 3. Reglas que tienen que respetar todos

1. **Orden de locks: solicitud → ofertas → búsqueda.** Si alguien actualiza en otro orden dentro de una transacción, aparecen deadlocks. Mi código reintenta ante deadlock, pero no hay que depender de eso.
2. **Ningún aviso externo (Redis, M4, M6) dentro de la transacción.** Se hacen después del commit; si fallan, se informan en `avisosFallidos` y no deshacen la asignación.
3. **Estados:** usar los enums de `src/comun/estados.js`. No definir strings sueltos (`"buscando"` vs `"BUSCANDO"` ya rompió cosas en el repo).
4. **Condicionales siempre:** cambiar estado con `WHERE estado = <esperado>` y mirar filas afectadas. Nunca leer y después escribir.
5. **Un endpoint = rol + validación + dueño:** `requerirRol` → `validar` → `verificarConductorDeOferta` → lógica.

## 4. Resultados posibles de la aceptación

| Resultado | HTTP | Significado |
|---|---|---|
| ASIGNADA | 200 | Este conductor quedó asignado (`repetida: true` si ya lo estaba) |
| YA_ASIGNADA | 409 | Otro conductor ganó |
| SOLICITUD_CANCELADA | 409 | Se canceló antes |
| SOLICITUD_NO_BUSCANDO | 409 | La solicitud ya no está buscando |
| OFERTA_NO_VIGENTE | 410 | Vencida / cancelada / rechazada |
| OFERTA_INEXISTENTE / SOLICITUD_INEXISTENTE | 404 | — |
| CONDUCTOR_NO_AUTORIZADO | 403 | El token no es del conductor de la oferta |

Alinear estos códigos con el catálogo de errores de Lautaro.

## 5. Preguntas abiertas

- **A:** ¿Mismo repo y mismo proceso? ¿Pueden exponer `asignar` y `marcarSinDisponibilidad` aceptando `tx` y como condicionales?
- **M1:** el token trae `identidad_id`, no `conductor_id`. ¿Viene un claim con el conductor o hay que consultarlo a M3? (`resolverConductorId` es enchufable.)
- **M4 / M6:** rutas y cuerpos para "liberar conductor" y "conductor asignado". En `notificaciones.js` quedan como parámetro `rutas`: **no las inventé**.
- **M6:** RF-6.7 devuelve una solicitud a despacho (ASIGNADA → BUSCANDO). ¿Quién lo ejecuta? Es una función más de A.

## 6. Limitaciones conocidas

- Los tests de concurrencia usan fakes en memoria con un mutex global, que es **más estricto** que MySQL. Prueban la lógica (y detectan los errores que introduje a propósito), pero falta una prueba contra MySQL real (docker-compose de Martin) con N respuestas simultáneas.
- El parser JSON va después de la autenticación (no se parsean cuerpos de requests no autenticados).
