// E3.21 · Pruebas del REGISTRO PERMANENTE de compras (/iap/claim y /iap/ack) con transacciones firmadas DE PRUEBA.
// Uso: node prueba_compras.js            (archivo local; y PostgreSQL si hay TEST_DATABASE_URL)
// Comprueba: sin registro no se entrega; una transacción = un jugador; reclamar dos veces no duplica; confirmar
// entrega; reembolsos (antes y después de entregar); productos anteriores con SU contenido; producto desconocido;
// jugador inválido; juego anterior (/iap/verify) sin doble entrega; reinicio del servidor sin perder registros;
// y en PostgreSQL, dos teléfonos reclamando la MISMA transacción a la vez: solo uno se la queda.
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let PORT = 19500 + Math.floor(Math.random() * 400);
let ok = 0, bad = 0;
function check(c, msg) {
  if (c) { ok++; console.log("  OK   " + msg); } else { bad++; console.log("  FALLA " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = __dirname + "/pruebas/";
const derB64 = (pem) => new crypto.X509Certificate(fs.readFileSync(T + pem)).raw.toString("base64");
const CHAIN = ["hoja_prueba.pem", "intermedio_prueba.pem", "raiz_prueba.pem"].map(derB64);
const ROOT_FP = crypto.createHash("sha256").update(new crypto.X509Certificate(fs.readFileSync(T + "raiz_prueba.pem")).raw).digest("hex").toUpperCase();
const KEY = crypto.createPrivateKey(fs.readFileSync(T + "hoja_prueba.key"));
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const PFX = "com.eduardotoriello.tennispower.";
function jws(tx, product, over = {}) {
  const payload = Object.assign({ transactionId: String(tx), originalTransactionId: String(tx), bundleId: "com.eduardotoriello.tennispower",
    productId: PFX + product, type: "Consumable", environment: "Sandbox", purchaseDate: Date.now() - 1000, signedDate: Date.now(), quantity: 1 }, over);
  const head = b64u(JSON.stringify({ alg: "ES256", x5c: CHAIN }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: KEY, dsaEncoding: "ieee-p1363" });
  return head + "." + body + "." + b64u(sig);
}
function post(p, obj) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: {} }));
    req.end(JSON.stringify(obj));
  });
}
function get(p) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} resolve(j); });
    }).on("error", () => resolve({}));
  });
}
function start(env) {
  const srv = spawn(process.execPath, [__dirname + "/servidor_salas.js"], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", IAP_ALLOW_TEST_ROOT: "1", IAP_TEST_ROOT_SHA256: ROOT_FP, IAP_PER_MIN: "10000",
      DATABASE_URL: "", IAP_LEDGER_FILE: "", RENDER: "" }, env),
  });
  srv.out = "";
  srv.stdout.on("data", (d) => (srv.out += d));
  srv.stderr.on("data", (d) => (srv.out += d));
  return srv;
}
async function stop(srv) {
  srv.kill("SIGTERM");
  await sleep(500);
}
const A = crypto.randomBytes(16).toString("hex");
const B = crypto.randomBytes(16).toString("hex");
const claim = (j, player) => post("/iap/claim", { jws: j, player });
const ack = (j, player, action) => post("/iap/ack", { jws: j, player, action });

async function suite(label, env) {
  console.log(`\n[Registro de compras · ${label}]`);
  let srv = start(env);
  await sleep(900);
  const base = 3000000000 + Math.floor(Math.random() * 100000) * 100;
  const h = await get("/health");
  check(h.srv === "E3.21" && String(h.registro_compras || "").startsWith(env.DATABASE_URL ? "postgres" : "archivo"), `/health dice el registro: «${h.registro_compras}»`);

  // 1) primera entrega
  const j1 = jws(base + 1, "coins1400");
  let r = await claim(j1, A);
  check(r.status === 200 && r.json.ok && r.json.state === "reclamada" && r.json.grant.kind === "coins" && r.json.grant.amount === 1400 && r.json.environment === "Sandbox",
    "reclamar: asignada al jugador A con su contenido (1400 monedas, Sandbox)");
  r = await claim(j1, A);
  check(r.json.ok && r.json.state === "reclamada" && r.json.grant.amount === 1400, "reclamar otra vez (app cerrada antes de guardar): misma respuesta, nada nuevo");
  r = await claim(j1, B);
  check(!r.json.ok && r.json.reason === "otro_jugador", "otro jugador (otro teléfono o progreso) NO puede quedarse con la misma transacción");
  r = await ack(j1, B, "entregada");
  check(!r.json.ok && r.json.reason === "otro_jugador", "otro jugador tampoco puede confirmarla");
  r = await ack(j1, A, "entregada");
  check(r.json.ok && r.json.state === "entregada", "confirmar entrega: «entregada»");
  r = await ack(j1, A, "entregada");
  check(r.json.ok && r.json.state === "entregada", "confirmar dos veces no cambia nada");
  r = await claim(j1, A);
  check(r.json.ok && r.json.state === "entregada", "la misma transacción después (respaldo viejo, reinstalación): «entregada», el juego no la vuelve a dar");

  // 2) reembolso después de entregar
  const j1r = jws(base + 1, "coins1400", { revocationDate: Date.now() });
  r = await claim(j1r, A);
  check(r.json.ok && r.json.state === "reembolso_pendiente" && r.json.revoked && r.json.grant.amount === 1400, "reembolso tras entregar: «reembolso_pendiente» con el contenido HISTÓRICO (1400)");
  r = await ack(j1r, A, "reembolso_aplicado");
  check(r.json.ok && r.json.state === "reembolso_aplicado", "el teléfono confirma que lo retiró");
  r = await claim(j1r, A);
  check(r.json.state === "reembolso_aplicado", "el reembolso no se aplica dos veces");

  // 3) reembolso antes de entregar
  const j2 = jws(base + 2, "xp1500");
  await claim(j2, A);
  r = await claim(jws(base + 2, "xp1500", { revocationDate: Date.now() }), A);
  check(r.json.state === "reembolsada_sin_entregar", "reembolso antes de entregar: no se entrega nada");
  r = await ack(j2, A, "entregada");
  check(r.json.state === "reembolsada_sin_entregar", "y ya no se puede marcar como entregada");

  // 4) productos y contenidos
  r = await claim(jws(base + 3, "xp850"), A);
  check(r.json.ok && r.json.grant.kind === "xp" && r.json.grant.amount === 850, "producto ANTERIOR (xp850): se entrega con su contenido de entonces (850 XP), no con el nuevo");
  r = await claim(jws(base + 4, "xp7500"), A);
  check(r.json.ok && r.json.grant.amount === 7500, "producto nuevo xp7500: 7500 XP");
  r = await claim(jws(base + 5, "gemas99"), A);
  check(!r.json.ok && r.json.reason === "producto_desconocido", "producto que no está en la tabla: no se entrega");
  r = await claim(jws(base + 6, "coins500"), "abc");
  check(!r.json.ok && r.json.reason === "jugador", "jugador con identificador inválido: no se entrega");
  r = await claim(jws(base + 7, "coins500", { bundleId: "com.otra.app" }), A);
  check(r.json.verified === false && r.json.reason === "app", "transacción de otra app: rechazada");
  const prod = jws(base + 8, "coins500", { environment: "Production" });
  r = await claim(prod, A);
  check(r.json.ok && r.json.environment === "Production", "el registro guarda el entorno (Production separado de Sandbox)");

  // 5) juego anterior (/iap/verify, builds 3 a 5)
  const jl = jws(base + 9, "coins500");
  r = await post("/iap/verify", { jws: jl, product: PFX + "coins500" });
  check(r.json.verified === true, "juego anterior: verifica igual que antes…");
  r = await claim(jl, A);
  check(!r.json.ok && r.json.reason === "otro_jugador", "…y queda anotada: un juego nuevo no la entrega otra vez");
  r = await post("/iap/verify", { jws: j1, product: PFX + "coins1400" });
  check(r.json.verified === false && r.json.reason === "ya_registrada", "juego anterior con una compra ya registrada a un jugador: no la verifica (no la acredita dos veces)");

  // 6) reinicio del servidor
  await stop(srv);
  srv = start(env);
  await sleep(900);
  r = await claim(j1, A);
  const r3 = await claim(jws(base + 3, "xp850"), B);
  check(r.json.state === "reembolso_aplicado" && r3.json.reason === "otro_jugador", "tras reiniciar el servidor el registro sigue completo (estados y dueños)");
  await stop(srv);
  return srv;
}

async function sinRegistro() {
  console.log("\n[Sin registro configurado]");
  const srv = start({});
  await sleep(800);
  const h = await get("/health");
  check(h.registro_compras === "sin_configurar", "/health dice «sin_configurar»");
  const r = await claim(jws(4000000001, "coins500"), A);
  check(r.status === 503 && r.json.verified === true && !r.json.ok && r.json.retry === true && r.json.reason === "registro_sin_configurar",
    "verifica la firma pero NO autoriza la entrega (el teléfono la deja pendiente y reintenta)");
  const v = await post("/iap/verify", { jws: jws(4000000002, "coins500"), product: PFX + "coins500" });
  check(v.json.verified === true, "el juego anterior sigue funcionando igual que en la E3.20");
  await stop(srv);
  const s2 = start({ IAP_LEDGER_FILE: path.join(os.tmpdir(), "nunca.jsonl"), RENDER: "true" });
  await sleep(800);
  const r2 = await claim(jws(4000000003, "coins500"), A);
  check(r2.status === 503 && !r2.json.ok, "en Render el archivo local está prohibido (su disco se borra): no entrega");
  await stop(s2);
}

async function carrera(env) {
  console.log("\n[PostgreSQL · dos teléfonos con el mismo Apple ID reclaman la MISMA compra a la vez]");
  const srv = start(env);
  await sleep(900);
  let duenos = 0;
  for (let i = 0; i < 20; i++) {
    const j = jws(5000000000 + Math.floor(Math.random() * 1e8), "coins3200");
    const [x, y] = await Promise.all([claim(j, A), claim(j, B)]);
    if ((x.json.ok ? 1 : 0) + (y.json.ok ? 1 : 0) === 1) duenos++;
  }
  check(duenos === 20, `20 de 20 carreras: exactamente un dueño cada vez (${duenos})`);
  await stop(srv);
}

(async () => {
  await sinRegistro();
  const f = path.join(os.tmpdir(), `registro_prueba_${process.pid}.jsonl`);
  await suite("archivo local (solo pruebas)", { IAP_LEDGER_FILE: f });
  fs.rmSync(f, { force: true });
  if (process.env.TEST_DATABASE_URL) {
    await suite("PostgreSQL", { DATABASE_URL: process.env.TEST_DATABASE_URL });
    await carrera({ DATABASE_URL: process.env.TEST_DATABASE_URL });
  } else {
    console.log("\n(sin TEST_DATABASE_URL: se omiten las pruebas con PostgreSQL)");
  }
  console.log(`\nPRUEBAS COMPRAS: ${ok} correctas, ${bad} fallidas`);
  process.exit(bad ? 1 : 0);
})();
