# Imagen del backend de M5 (G04). Aporte del equipo DevOps (Grupo 5).
#
# Dos etapas: en la primera se instalan las dependencias y se genera el cliente de
# Prisma; en la segunda queda solo lo necesario para correr (sin dependencias de
# desarrollo), con un usuario sin privilegios y un HEALTHCHECK sobre /health.
#
# Las variables de entorno (base de datos, Keycloak, URLs de los otros módulos,
# INTERNAL_API_TOKEN) se pasan al contenedor: no hay secretos en la imagen (RNF-06).
# El frontend (front/) es una aplicación aparte y no se incluye.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY bd/prisma7.config.ts bd/prisma7.config.ts
COPY bd/prisma bd/prisma
RUN npm run db:generate && npm prune --omit=dev


FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/main.js"]
