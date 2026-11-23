# M5 - Solicitudes y despacho

Este repositorio contiene el módulo M5 de la plataforma. Sus carpetas separan
la interfaz, la persistencia de solicitudes, la lógica de búsqueda/asignación,
la documentación y las pruebas.

## Carpetas principales

| Carpeta | Contenido y responsabilidad |
|---|---|
| `front/` | Interfaz web y servidor HTTP del frontend. `servidor.js` sirve las páginas estáticas, realiza el login/autorización con Keycloak y expone las rutas usadas por la interfaz. |
| `front/js/` | Lógica del navegador: `auth.js` inicializa Keycloak y aplica la navegación por roles; los otros archivos manejan las pantallas de solicitudes, administración y creación de viajes. |
| `front/css/` | Estilos de cada pantalla del frontend. |
| `bd/` | API de persistencia de M5, conexión a MySQL mediante Prisma, esquema de solicitudes y compose para levantar MySQL. |
| `bd/prisma/` | Esquema Prisma de las solicitudes almacenadas por M5. |
| `src/` | Lógica de dominio y componentes del backend de solicitudes/despacho. |
| `src/asignacion/` | Procesamiento de aceptación, asignación única, cancelaciones, búsqueda agotada, notificaciones y puertos requeridos por el orquestador. |
| `src/busqueda/` | Búsqueda y ordenamiento de candidatos, además de pruebas relacionadas. |
| `src/clientes/` | Clientes HTTP que M5 utiliza para consultar otros módulos; actualmente incluye el cliente de M3/M4. |
| `src/comun/` | Componentes compartidos del backend, como configuración, autenticación, roles, estados, validación, errores, logging, salud y cliente HTTP. |
| `src/ofertas/` | Espacio previsto para la lógica de envío y gestión de ofertas. |
| `tests/` | Pruebas automatizadas y utilidades para asignación, seguridad, cliente HTTP y ejemplos de routers. |
| `docs/` | Contratos y documentación de integración, configuración de Keycloak, variables de entorno y materiales de prueba. |

## Archivos de configuración y guías

- `readmeParaLevantarBD.txt`: pasos actuales para levantar MySQL, Keycloak,
  la API de persistencia y el frontend en desarrollo local.
- `docs/keycloak.md`: configuración de autenticación y roles del frontend.
- `docs/openapi-a.yml`: contrato de integración publicado para M5.
- `docs/contrato-interno-m5.md`: acuerdos internos y dependencias de la lógica
  de asignación.
- `bd/.env.example` y `front/.env.example`: plantillas de configuración. Los
  archivos `.env` locales pueden contener secretos y no deben subirse al
  repositorio.

## Estado actual

La API de persistencia implementada en `bd/index.js` guarda solicitudes M5 en
MySQL. El frontend se inicia por separado desde `front/servidor.js`; los pasos
están en `readmeParaLevantarBD.txt`.

`src/main.js` contiene actualmente un esquema/pseudocódigo del flujo de
despacho; no es un entrypoint Node.js ejecutable. Además, `src/ofertas/` y
algunas áreas de `src/` están presentes como estructura de trabajo, pero no
tienen todavía la implementación completa del flujo distribuido.
