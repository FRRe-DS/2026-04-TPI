FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/tiempo-real/servidor-integrado.js"]
