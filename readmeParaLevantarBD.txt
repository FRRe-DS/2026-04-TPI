comandos para levantar la base de datos

aclaración hay 2 .env uno en front y otro en bd

hay que tener instalado docker

///////////////////////////////////////////////////////////////////////////
PASO 1

direccion: raiz/bd
npm install                    ---una vez
npx prisma db push
npx prisma generate



//////////////////////////////////////////////////////////////////////////
PASO 2

dirección: cualquiera

docker compose up -d

COMANDO ENTERO{

docker run -d --name keycloak `
  -p 127.0.0.1:8080:8080 `
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin `
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=Admin123! `
  quay.io/keycloak/keycloak:26.8.1 start-dev

}COMANDO ENTERO


docker start keycloak         ---hay que instalar dependencia es lo de arriba


docker compose ps              ---status (opcional)
docker logs -f keycloak        ---revisar registros (opcional)


/////////////////////////////////////////////////////////////////////////////////
PASO 3

direccion: raiz/bd

node --env-file=.env index.js  ---levanta la base de datos tener (.env   importante)



//////////////////////////////////////////////////////////////////////////////
PASO 4

direccion: raíz(2026-04-TPI)

npm install   ---- una vez

node --env-file=src/front/.env src/front/servidor.js   -----tener .env en front importante


//////////////////////////////////
docker stop despacho_db
docker stop keycloak

////////////////////////////////////

RECORDATORIOS IMPORTANTES

Dependencias

Ejecutar npm install una sola vez por cada carpeta que tenga su propio package.json.

Si se elimina node_modules, volver a ejecutar npm install.

No compartir las carpetas node_modules mediante Git.

Compartir package.json y package-lock.json.

Keycloak

Keycloak funciona mediante Docker, no mediante npm.

Primera ejecución: crear el contenedor con docker run.

Ejecuciones posteriores: docker start keycloak.

La configuración del realm bajer, clientes, roles y usuarios debe estar importada o configurada en cada entorno.

Archivos .env

Cada integrante debe tener su propio .env.

No subir secretos ni contraseñas a GitHub.

Utilizar los archivos .env.example como referencia.

Base de datos

MySQL se ejecuta dentro de Docker.

Prisma sincroniza el modelo con MySQL.

No ejecutar docker compose down -v, porque puede eliminar los volúmenes y los datos almacenados.

Direcciones locales

Frontend: http://localhost:3005

Backend: http://localhost:3000

Keycloak: http://localhost:8080

MySQL: localhost:3306

IMPORTANTE: Para utilizar el sistema deben estar activos Docker, MySQL, Keycloak, el backend y el frontend.

