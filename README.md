# M5 - Solicitudes y despacho

Este repositorio contiene el módulo M5 de la plataforma. Sus carpetas separan
la interfaz, la persistencia de solicitudes, la lógica de búsqueda/asignación,
la documentación y las pruebas.

## Carpetas principales

| Carpeta | Contenido y responsabilidad |
|---|---|
| `front/` | Interfaz web y BFF HTTP. `servidor.js` sirve las páginas estáticas, valida login/roles con Keycloak y reenvía las operaciones al backend `src/main.js`. |
| `front/js/` | Lógica del navegador: `auth.js` inicializa Keycloak y aplica la navegación por roles; los otros archivos manejan las pantallas de solicitudes, administración y creación de viajes. |
| `front/css/` | Estilos de cada pantalla del frontend. |
| `bd/` | Configuración de MySQL y esquema Prisma compartido por el backend; `index.js` conserva una API de persistencia simple para desarrollo anterior. |
| `bd/prisma/` | Esquema Prisma de solicitudes, ofertas, búsquedas, candidatos y eventos. |
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

El backend principal persiste solicitudes y datos de despacho en MySQL. El
frontend se inicia por separado desde `front/servidor.js`; los pasos de la
arquitectura integrada están en la sección siguiente.

`src/main.js` es el backend de M5. El frontend valida la sesión con Keycloak y
envía sus operaciones a esta API; el backend persiste solicitudes con Prisma,
coordina el despacho por tandas y procesa respuestas de conductores. Las
llamadas a M3, M4, M6 y M7 se configuran por variables de entorno. Las rutas
que los contratos externos aún no fijan deben completarse antes de iniciar el
servidor.

## Iniciar el backend integrado

1. Instalá las dependencias desde la raíz con `npm install`.
2. Usá `.env.example` como plantilla para completar `.env`: configurá MySQL,
   Keycloak, los módulos externos y sus rutas. `INTERNAL_API_TOKEN` debe tener
   exactamente el mismo valor en `.env` y `front/.env`.
3. Configurá `front/.env` con el mismo `INTERNAL_API_TOKEN` y
   `API_URL=http://localhost:3001`.
4. Con MySQL disponible, ejecutá `npm run db:generate` y `npm run db:push`.
5. Iniciá el backend con `npm start` y el frontend con
   `node --env-file=front/.env front/servidor.js`.

El puerto `3001` es el backend principal. El backend accede a MySQL directamente;
no inicies `bd/index.js` como API para el frontend, porque omite la lógica de
despacho de `src/main.js`.
