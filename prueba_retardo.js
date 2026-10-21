// SOLO PRUEBAS · Intermediario WebSocket que retrasa cada mensaje (latencia + variación) en los dos sentidos,
// manteniendo el orden (como TCP). Sirve para medir el partido en línea con una red "de lejos".
// Uso: LISTEN=19001 TARGET=ws://127.0.0.1:19000 LAG_MS=60 JITTER_MS=30 node prueba_retardo.js
"use strict";
const WebSocket = require("ws");
const LISTEN = parseInt(process.env.LISTEN || "19001", 10);
const TARGET = process.env.TARGET || "ws://127.0.0.1:8090";
const LAG = parseFloat(process.env.LAG_MS || "50");
const JIT = parseFloat(process.env.JITTER_MS || "0");

function pipe(from, to) {
  // una sola cola por sentido: cada mensaje sale cuando le toca y SIEMPRE en el orden en que llegó
  const q = [];
  let timer = null;
  let last = 0;
  const flush = () => {
    timer = null;
    const now = Date.now();
    while (q.length && q[0].at <= now && to.readyState === 1) {
      const it = q.shift();
      to.send(it.d, { binary: it.bin });
    }
    if (q.length) timer = setTimeout(flush, Math.max(1, q[0].at - Date.now()));
  };
  from.on("message", (d, bin) => {
    const at = Math.max(Date.now() + LAG + Math.random() * JIT, last);
    last = at;
    q.push({ d, bin, at });
    if (!timer) timer = setTimeout(flush, Math.max(1, q[0].at - Date.now()));
  });
  to.on("open", () => { if (!timer) flush(); });
}

const wss = new WebSocket.Server({ port: LISTEN, host: "127.0.0.1" });
wss.on("connection", (client) => {
  const up = new WebSocket(TARGET);
  pipe(client, up);
  pipe(up, client);
  const closeBoth = () => { try { client.close(); } catch (e) {} try { up.close(); } catch (e) {} };
  client.on("close", closeBoth);
  up.on("close", closeBoth);
  client.on("error", () => {});
  up.on("error", () => {});
});
console.log(`retardo ${LAG}±${JIT} ms: ${LISTEN} → ${TARGET}`);
