# Estado de integración de M5

**Revisión:** 25 de noviembre de 2026  
**Alcance:** estado observado de los contratos y del código de M5 frente a los módulos relacionados.  
**Nota:** este documento es una guía de seguimiento. Los OpenAPI de cada módulo y su implementación vigente son la referencia final. La compatibilidad de contrato no demuestra que los servicios estén desplegados o que la conexión funcione en ejecución. No se ejecutaron pruebas como parte de esta revisión.

## Resumen

| Módulo | Estado de la conexión con M5 | Pendiente principal |
|---|---|---|
| M1 / Keycloak | Parcial: M5 valida JWT y usa credenciales de servicio configuradas por entorno. | Configurar roles y scopes correctos; resolver la gestión/renovación de tokens de servicio. |
| M2 | Alineada por contrato y llamada desde M5. | Configurar URL y token, y comprobar el servicio en ejecución. |
| M3 | Alineada en los endpoints de ofertas, respuesta y datos de despacho. | Asegurar que el vehículo asignado no cambie durante reintentos; confirmar la estabilidad del identificador. |
| M4 | Alineada en rutas, nombres de campos y kilómetros. | Corregir/confirmar validación real con M3 y reservas; decidir cómo ampliar la búsqueda en tandas posteriores. |
| M5 | Es el módulo integrador; crea solicitudes y coordina llamadas HTTP a varios módulos. | Completar las conexiones de eventos/notificaciones y resolver los pendientes de M3, M4, M6, M8 y M9. |
| M6 | Parcial: creación inicial del viaje está alineada. | Consumir cancelaciones de RabbitMQ y definir redespacho e identificadores por intento. |
| M7 | Alineada por contrato para estimar tarifa. | Configurar `M7_TOKEN` con el scope requerido y verificar conexión en ejecución. |
| M8 | Pendiente: M5 documenta eventos, pero no tiene cliente de notificaciones implementado. | Acordar contrato/eventos y canales; implementar el envío. |
| M9 | Parcial: M5 expone creación de solicitud desde reserva. | Confirmar la llamada real desde M9 e implementar el aviso de resultado de despacho hacia M9. |

## Estado por módulo

### M1 / Keycloak — autenticación

- M5 valida identidad/autorización mediante JWT y usa tokens de servicio para llamadas entre módulos.
- La configuración local de ejemplo deja vacías credenciales como `M2_TOKEN`, `M3_TOKEN`, `M4_TOKEN`, `M6_TOKEN` y `M7_TOKEN`; el despliegue debe suministrar tokens válidos con los roles/scopes que exige cada servicio.
- El token interno de M5 y las rutas de servicio tienen mecanismos de autorización propios. Hay que mantener coherentes la configuración de Keycloak y las políticas de cada módulo.
- **Pendiente:** comprobar los roles/scopes efectivos de cada cliente de servicio y definir cómo se renuevan/rotan los tokens. La presencia de un realm compartido no confirma por sí sola que las credenciales desplegadas sean válidas.

### M2 — estado de cuenta del cliente

- M5 consulta `GET /api/v1/clientes/{clienteId}/estado-cuenta` antes de crear/activar solicitudes.
- La ruta y los datos que consume M5 coinciden con el contrato revisado de M2 (`clienteId`, `estado` y `bloqueosVigentes`). M5 exige que el estado sea `ACTIVO`.
- **Pendiente:** establecer `M2_URL` y `M2_TOKEN` en el entorno y verificar conectividad/autorización con ambos servicios levantados.
- **Estado:** alineada a nivel de contrato y código; ejecución no verificada.

### M3 — ofertas y datos del conductor

- M5 envía las ofertas individualmente a `POST /api/v1/integration/m5/offers`, con los campos camelCase del contrato vigente de M3. M3 responde con aceptación HTTP 202 y contempla deduplicación por oferta.
- M5 recibe la respuesta del conductor en `POST /api/v1/offers/{offerId}/driver-response`, valida `Idempotency-Key` y adapta la respuesta al formato esperado por M3 (`status`, `tripId`).
- Antes de asignar, M5 consulta `POST /api/v1/integration/drivers/dispatch-info` con `{ conductor_id }`. Usa los indicadores `habilitado` y `disponible`, además del `vehiculo_id` y `tipo_vehiculo` devueltos.
- El identificador de vehículo se envía luego a M6 como `vehicleId`. Es importante que se mantenga estable durante el procesamiento y los reintentos.
- **Pendiente:** M5 vuelve a consultar los datos de despacho al procesar una respuesta repetida y no recupera el `vehiculo_id` previamente persistido. Si el valor cambia, una repetición a M6 con el mismo `requestId` puede diferir de la primera y producir conflicto. Hay que garantizar estabilidad en M3 o reutilizar en M5 el valor persistido.
- La propuesta de un endpoint por lotes (`POST /api/v1/solicitudes/ofertas/lotes`) no corresponde a la interfaz vigente revisada en M3: actualmente M5 sigue el envío individual acordado con el código de M3.
- **Estado:** contratos de llamadas revisados alineados; pendiente de resolver/confirmar estabilidad del vehículo y verificar ejecución.

### M4 — búsqueda, estimación de ruta y reservas

- Para buscar conductores, M5 consulta `GET /api/v1/conductores/cercanos` con origen y tipo de vehículo. Mapea `conductores[]`, `conductor_id`, `distancia_origen_km`, `eta_retiro_minutos` y `tipo_vehiculo`.
- Las distancias se mantienen en **kilómetros**; M5 no las convierte a metros. El parámetro opcional `limite` se omite y se utiliza el valor predeterminado de M4.
- M5 reserva y libera con `POST /api/v1/conductores/{conductor_id}/reserva`, enviando `estado_temporal` (`RESERVADO` o `LIBERADO`) y `solicitud_id`, junto con una clave de idempotencia.
- Para estimar la ruta, M5 usa `GET /api/v1/rutas/estimacion` y consume `distancia_estimada_km` y `eta_minutos`.
- **Pendientes detectados en M4:**
  - La comprobación de habilitación contra M3 aparece simulada en la implementación revisada; confirmar que se reemplace por la validación real.
  - El listado puede volver a considerar elegible un conductor liberado, mientras que la reserva puede rechazarlo por conservar un registro anterior durante su TTL. Confirmar/corregir el ciclo liberar → nueva reserva.
  - La reserva debe ser atómica ante dos solicitudes concurrentes. La revisión del código no permitió confirmar que exista una operación atómica/lock que evite una doble asignación.
  - M4 amplía radios hasta hallar conductores. M5 obtiene y conserva una lista al iniciar el despacho; las tandas siguientes no vuelven a pedir candidatos, por lo que podrían no alcanzar conductores de radios más amplios.
- **Estado:** interfaz HTTP y unidad compatibles; quedan pendientes de comportamiento/confirmación en M4 y una decisión de búsqueda en M5.

### M6 — creación y cancelación del viaje

- M5 crea viajes en `POST /trips`, enviando `requestId` desde `solicitud_id`, cliente, conductor, vehículo, tipo y coordenadas. La respuesta `id` de M6 se usa como `tripId`.
- La forma de la solicitud inicial coincide con el OpenAPI revisado. M6 aplica idempotencia de dominio usando `requestId`: repetirlo con datos distintos puede devolver `409`. M5 reintenta con el mismo cuerpo y la misma clave cuando corresponde.
- M6 requiere un rol de servicio que reconozca como `SYSTEM`; hay que validar que `M6_TOKEN` tenga ese rol.
- **Pendiente de eventos:** M6 publica cancelaciones en el exchange `movilidad.eventos`, con routing key `trips.trip.cancelled`. M5 todavía no tiene consumidor de RabbitMQ. Su OpenAPI documenta `m6.events` y `trip.cancelled`, por lo que esos nombres no coinciden con AsyncAPI de M6; se deben acordar y actualizar antes de conectar el consumidor.
- El evento puede indicar `requiresRedispatch: true`, pero M5 no implementa el consumo ni el redespacho automático. Además, M6 pide un `requestId` nuevo para un viaje redespachado, mientras M5 hoy deriva `requestId` de la misma solicitud. Hay que definir y persistir un identificador distinto por intento.
- **Estado:** alta inicial alineada; cancelaciones/redespacho pendientes.

### M7 — cálculo de tarifa

- M5 estima la ruta con M4 y envía a M7 `POST /api/v1/tarifas/estimaciones` con `tipo_vehiculo`, `distancia_km` y `duracion_estimada_min`.
- Los nombres y unidades coinciden con el contrato revisado; M5 conserva kilómetros y redondea la duración estimada a minutos enteros. Lee el total del desglose devuelto.
- El servicio requiere el scope `tarifas:read`; hay que verificarlo en `M7_TOKEN`. M7 puede no ser necesario para levantar M5, pero sí para los flujos que calculan tarifa.
- **Estado:** alineada por contrato; falta configurar y verificar la conexión real.

### M8 — notificaciones

- M5 no tiene implementado el cliente/envío de notificaciones a M8. El OpenAPI de M5 describe una propuesta de `POST /api/v1/eventos`, todavía no conectada al flujo.
- El contrato de M8 revisado requiere `eventoId`, `tipo`, `origen`, `ocurridoEn` y `destinatarios`, y exige una referencia a viaje, reserva o pago. No incluye `solicitudId` en el esquema inspeccionado, lo que dificulta notificar sucesos anteriores a la creación del viaje.
- Los eventos propuestos por M5, como `SOLICITUD_CANCELADA` y `BUSQUEDA_SIN_CONDUCTOR`, deben cotejarse con el enum vigente de M8 antes de implementarlos.
- Canales comunicados por el equipo: cliente de viaje inmediato **PUSH y EMAIL**; cliente de viaje desde reserva **PUSH**; conductor **PUSH**.
- **Pendiente:** acordar el esquema y tipos de evento definitivos con M8, agregar configuración de URL/token y luego implementar/validar el envío idempotente.
- **Estado:** no conectada.

### M9 — reservas

- M5 expone `POST /solicitudes/desde-reserva` para recibir una reserva con `reserva_id`, `cliente_id`, coordenadas y tipo de vehículo. Valida el cliente en M2, estima tarifa con M7 y crea/inicia el despacho. La ruta está documentada en el OpenAPI de M5.
- M9 documenta que activa una solicitud M5 y espera `solicitudDespachoId`, pero la integración revisada en M9 figura simulada; la llamada real no está confirmada.
- M9 también define un callback de M5 hacia M9 para informar el resultado del despacho. M5 no tiene configuración `M9_URL`/token ni código de callback, así que M9 no recibe automáticamente la confirmación o vencimiento del despacho.
- **Estado:** entrada M9 → M5 preparada en M5; ciclo completo pendiente por llamada real desde M9 y callback M5 → M9.

## Orden sugerido de pendientes

1. **M4:** validar habilitación real con M3, resolver la reserva tras liberar y confirmar atomicidad; definir si M5 vuelve a buscar candidatos al agotar una tanda.
2. **M6:** acordar exchange/routing key, implementar consumidor de cancelaciones y decidir redespacho con un `requestId` nuevo por intento.
3. **M3:** garantizar que el `vehicleId` asociado a una asignación permanezca estable y que M5 reutilice ese dato en reintentos.
4. **M8:** acordar el contrato de eventos/canales y conectar el envío de notificaciones.
5. **M9:** pasar de integración simulada a llamada real y completar el callback del resultado del despacho.
6. **M1 y configuración:** provisionar URLs, roles/scopes y tokens vigentes para M2, M3, M4, M6 y M7; verificar los flujos en un entorno integrado.

## Cómo mantener este documento

Actualizar la fila y el apartado del módulo cada vez que cambie un contrato, se implemente una conexión o se confirme su comportamiento en ejecución. Registrar por separado “contrato alineado” y “conexión probada”: son estados distintos.

## Qué le falta a M5 para funcionar correctamente

Esta lista se limita a **M5**: su configuración, su backend, su persistencia y su frontend. No evalúa conexiones entre otros módulos.

### Requisitos para levantar M5

- **Completar la configuración local:** crear `.env` desde `.env.example`; definir puerto, parámetros de MySQL, URL/realm de Keycloak y un `INTERNAL_API_TOKEN` seguro de al menos 32 caracteres. El mismo token debe estar en `front/.env` para que el BFF pueda llamar al backend.
- **Preparar la base de datos de M5:** asegurar que MySQL esté levantado, que la base configurada exista y que el usuario tenga permisos. Generar el cliente Prisma y aplicar el esquema de `bd/prisma/schema.prisma` con los comandos documentados (`npm run db:generate` y `npm run db:push`).
- **Configurar las dependencias que M5 invoca:** completar las URL y credenciales de los servicios usados por los flujos que se quieran habilitar. Los tokens no pueden quedar vacíos en un entorno integrado. En particular, M5 exige `M2_URL` para iniciar sus dependencias y usa M7 al estimar tarifas.
- **Alinear Keycloak con la configuración de M5:** verificar que el realm exista y que sus JWT incluyan los claims de identidad, roles, conductor y scopes indicados por las variables `JWT_CLAIM_*`; la respuesta de ofertas requiere verificación de JWT.
- **Levantar backend y frontend como procesos separados:** backend M5 con `npm start` en el puerto configurado y frontend/BFF con `node --env-file=front/.env front/servidor.js`; `API_URL` del frontend debe apuntar al backend. Para el frontend también deben estar completos los datos de conexión a Keycloak.
- **Usar `src/main.js` como API principal:** es el proceso que aplica autenticación, persistencia y despacho. `bd/index.js` es una API de persistencia anterior y no reemplaza al backend principal ni debe levantarse como backend del frontend integrado.

### Pendientes propios de M5

- **Verificar persistencia real:** el comentario de `src/busqueda/repositorioCandidatos.js` advierte que no se probó con MySQL real. Hay que comprobar que el esquema y las operaciones Prisma de solicitudes, ofertas, candidatos, búsquedas y eventos funcionen con la base preparada.
- **Completar y verificar pruebas del flujo completo de M5:** alta, validación, búsqueda por tandas, expiración de ofertas, respuesta idempotente, asignación única, cancelación, liberación y recuperación tras reinicio. La revisión que originó este documento no ejecutó pruebas.
- **Comprobar el flujo frontend → BFF → API M5:** iniciar sesión, enviar una solicitud, consultar su estado y manejar errores de autenticación o indisponibilidad. Confirmar que las pantallas actuales usan las rutas del backend principal.
- **Cerrar los comportamientos incompletos que M5 controla:** conservar el `vehicleId` asignado para reintentos; decidir si al agotarse una tanda M5 vuelve a solicitar candidatos; y definir el manejo de cancelación/redespacho antes de dar por completo el ciclo de despacho.
- **Completar notificaciones y seguimiento de reservas dentro del flujo M5:** el código de M5 todavía no envía eventos a M8 ni informa a M9 el resultado del despacho. Si esos recorridos forman parte del alcance que se debe entregar, M5 necesita implementar esos envíos y configurar sus credenciales.
- **Verificar observabilidad y cierre:** revisar `/health` y `/health/ready`, logs con identificador de solicitud y apagado ordenado de los trabajos periódicos y de Prisma.

### Criterio práctico de “M5 listo”

M5 puede considerarse listo para una demostración integrada cuando arranca con su configuración, conecta a su MySQL, el frontend llega a `src/main.js`, los servicios requeridos responden con credenciales válidas y se completa de punta a punta al menos un flujo de solicitud y despacho. Para considerarlo listo para entrega, además deben resolverse los pendientes propios enumerados arriba y probar los casos de error, repetición y recuperación.
