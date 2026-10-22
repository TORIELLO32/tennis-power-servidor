# Servidor de salas de TENNIS POWER (protocolo 3, E3.18) y verificación de compras, para alojamientos con Docker (Render, Koyeb, Fly.io, un VPS…).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY servidor_salas.js verificar_compras.js ./
ENV PORT=8090 HOST=0.0.0.0
EXPOSE 8090
USER node
CMD ["node", "servidor_salas.js"]
