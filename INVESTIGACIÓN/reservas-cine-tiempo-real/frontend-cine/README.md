# Cine/Live · Acceso y reservas

Abrí el gateway en [localhost:8080](http://localhost:8080). La pantalla de acceso te pide usuario y contraseña. Al ingresar, podés elegir una función, bloquear un asiento y confirmar la compra. La versión de [polling](http://localhost:8080/polling.html) usa la misma sesión dentro de la pestaña.

## Cuentas de demostración

| Usuario | Contraseña |
| --- | --- |
| ana | luna |
| leo | cine |
| sol | sala |

Para probar dos usuarios a la vez, abrí el sitio en dos pestañas nuevas escribiendo la dirección y elegí una cuenta en cada una. Si duplicás una pestaña, el navegador puede copiar la sesión inicial. Usá **Cerrar sesión** en esa pestaña para cambiar de usuario.

## Arranque con Docker

Desde la carpeta del repositorio que contiene `docker-compose.yml`, usá el mismo proyecto Compose con el que levantaste las bases. Si ya configuraste `COMPOSE_PROJECT_NAME` en el `.env` de la raíz, usá estos comandos.

```powershell
docker compose up -d --build --wait
docker compose ps
```

El gateway sigue publicando el puerto 8080. Nginx sirve `public/` y envía `POST /sesion` al servidor interno de `frontend-cine`. Compose comparte el valor de `JWT_SECRET` entre ese servidor, Asientos y Funciones. Los dos volúmenes de MySQL pertenecen al proyecto Compose.

## Funcionamiento de la sesión

El servidor comprueba usuario y contraseña y firma un JWT HS256 de ocho horas con el usuario en `sub`. La pestaña conserva el token, el usuario y el vencimiento en `sessionStorage`. El cliente usa ese token para REST y WebSocket. Cerrar sesión descarta la copia de la pestaña y cierra su conexión. Un bloqueo existente conserva su vencimiento normal. Al vencer la sesión, el cliente vuelve al login.

Las cuentas de esta práctica están definidas en `server.js` mediante verificadores scrypt con una sal por cuenta. El secreto de firma se recibe por entorno. Los archivos que recibe el navegador están en `public/`.

## Ejecución directa con Node

Con el gateway en el puerto 8080 y los servicios en ejecución, entrá en `frontend-cine`, ejecutá `npm ci` y configurá `JWT_SECRET` en el entorno del servidor con el mismo valor que usan las APIs. Ejecutá `npm start` y abrí [localhost:3000](http://localhost:3000). El formulario se autentica contra ese servidor y las reservas pasan por el gateway.

## Pruebas

Desde `frontend-cine`, ejecutá `npm ci` y `npm test`. La prueba levanta un servidor local en un puerto libre, firma con un secreto de prueba y verifica las tres identidades, las credenciales incorrectas y el vencimiento.
