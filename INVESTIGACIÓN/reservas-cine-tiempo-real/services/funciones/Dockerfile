FROM node:20-alpine

WORKDIR /app

# Copia los archivos de dependencias primero (aprovecha caché)
COPY package*.json ./

# Instala dependencias
RUN npm install --production

# Copia el resto del código
COPY . .

EXPOSE 8080

CMD ["node", "src/server.js"]