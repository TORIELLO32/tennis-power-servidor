# Servidor de salas de TENNIS POWER (protocolo 2) para alojamientos con Docker (Koyeb, Fly.io, un VPS…).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY servidor_salas.js ./
ENV PORT=8090 HOST=0.0.0.0
EXPOSE 8090
USER node
CMD ["node", "servidor_salas.js"]
