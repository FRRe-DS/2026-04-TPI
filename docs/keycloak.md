# Inicio de sesión y permisos con Keycloak

## Configurar el realm

1. Iniciá Keycloak y creá el realm `bajer` (o elegí otro nombre y actualizá el `.env` del frontend).
2. Creá los roles de realm `cliente`, `encargado` y `administrador`.
3. Creá el cliente `m5-web` como público, activá Standard Flow y PKCE S256. Configurá `Valid redirect URIs` como `http://localhost:3005/*` y `Web origins` como `http://localhost:3005`.
4. Para el servidor, creá el cliente confidencial `m5-admin-api`, activá Service Accounts y guardá su secret en `KEYCLOAK_ADMIN_CLIENT_SECRET`. A su service account asignale los roles de cliente `realm-management`: `view-users`, `query-users` y `manage-users`.
5. En el cliente confidencial habilitá la evaluación de tokens (Service Accounts Enabled). El servidor usa ese cliente para introspección y para administrar los roles de usuarios.
6. Asigná inicialmente el rol `administrador` a una cuenta desde la consola de Keycloak. Los usuarios que no tengan uno de los tres roles verán la pantalla de acceso denegado.

Copiá `src/front/.env.example` como `src/front/.env` (o exportá esas variables en el entorno) y completá la URL, realm y secret. Iniciá el servidor de frontend desde la raíz:

```powershell
node --env-file=src/front/.env src/front/servidor.js
```

La interfaz usa el adaptador JavaScript que sirve la propia instancia Keycloak en `/js/keycloak.js`; el navegador debe poder acceder a esa URL.

## Permisos de la aplicación

- `cliente`: `/ventana-de-solicitud.html`; puede crear solicitudes.
- `encargado`: `/solicitudes.html`; puede consultar solicitudes.
- `administrador`: `/ventana-administrador.html`; puede listar usuarios y asignarles uno de los tres roles.

Las rutas de la interfaz redirigen al usuario a su pantalla autorizada y los endpoints del frontend validan el token y el rol antes de atender solicitudes. El alta, contraseña, bloqueo y recuperación de cuentas siguen siendo administrados por Keycloak.
