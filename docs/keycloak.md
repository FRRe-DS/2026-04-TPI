# Inicio de sesión y permisos con Keycloak

## Configurar el realm

1. Iniciá Keycloak y usá el realm indicado por `KEYCLOAK_REALM` en `front/.env`.
2. Creá los **roles de realm** `clientes-be` y `solicitud-be`. Son los nombres exactos que valida la aplicación: cliente usa `clientes-be` y encargado usa `solicitud-be`.
3. Creá o seleccioná el cliente indicado por `KEYCLOAK_CLIENT_ID` (en la configuración local actual, `grupo-04`). Debe ser público y tener Standard Flow y PKCE S256 habilitados. Configurá `Valid redirect URIs` como `http://localhost:3005/*` y `Web origins` como `http://localhost:3005`.

Copiá `front/.env.example` como `front/.env` (o exportá esas variables en el entorno) y completá la URL, realm y secret. Iniciá el servidor de frontend desde la raíz:

```powershell
node --env-file=front/.env front/servidor.js
```

La interfaz usa el adaptador JavaScript que sirve la propia instancia Keycloak en `/js/keycloak.js`; el navegador debe poder acceder a esa URL.

## Permisos de la aplicación

- `clientes-be`: `/ventana-de-solicitud.html` y `/viaje-activo.html`; puede crear y cancelar sus propias solicitudes.
- `solicitud-be`: `/solicitudes.html`; puede consultar y eliminar solicitudes.

Las rutas de la interfaz redirigen al usuario a su pantalla autorizada y los endpoints del frontend validan el token y el rol antes de atender solicitudes. El alta, contraseña, bloqueo y recuperación de cuentas siguen siendo administrados por Keycloak.
