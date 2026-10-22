// Pruebas automáticas del servidor de salas (E3.18 · protocolo 3; el 2 sigue aceptado): arranca el servidor en un puerto libre
// y simula clientes reales por WebSocket. Uso: npm test
// Comprueba: crear/unirse, códigos inválidos, sala llena, versiones, origen (web vs app nativa), LISTO,
// inicio, entradas validadas (duplicadas, atrasadas, de otro partido, mal formadas), fin por consenso,
// sin resultado si no coinciden, revancha, reconexión, abandono, reinicio del servidor, salud, límites y
// varias salas a la vez. Al final mide el tamaño real del tráfico de un partido.
// E3.18: niveles de mejoras en línea (validación y reparto en "start"), compatibilidad con el protocolo 2 y
// verificación de compras de App Store (/iap/verify) con una cadena de certificados DE PRUEBA (server/pruebas).
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");
const { verifyJws, APPLE_ROOT_G3_SHA256 } = require("./verificar_compras");

let PORT = 18000 + Math.floor(Math.random() * 1000);
let ok = 0, bad = 0;
function check(c, msg) {
  if (c) { ok++; console.log("  OK   " + msg); } else { bad++; console.log("  FALLA " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = 3;
const VER = "0.3.18";

// ---- E3.18 · transacciones firmadas DE PRUEBA (misma forma que las de Apple, otra raíz)
const T = __dirname + "/pruebas/";
const derB64 = (pem) => new crypto.X509Certificate(fs.readFileSync(T + pem)).raw.toString("base64");
const TEST_CHAIN = ["hoja_prueba.pem", "intermedio_prueba.pem", "raiz_prueba.pem"].map(derB64);
const TEST_ROOT_FP = crypto.createHash("sha256").update(new crypto.X509Certificate(fs.readFileSync(T + "raiz_prueba.pem")).raw).digest("hex").toUpperCase();
const TEST_KEY = crypto.createPrivateKey(fs.readFileSync(T + "hoja_prueba.key"));
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function makeJws(over = {}, chain = TEST_CHAIN, key = TEST_KEY) {
  const payload = Object.assign({ transactionId: "2000000123456789", originalTransactionId: "2000000123456789",
    bundleId: "com.eduardotoriello.tennispower", productId: "com.eduardotoriello.tennispower.xp850", type: "Consumable",
    environment: "Sandbox", purchaseDate: Date.now() - 1000, signedDate: Date.now(), quantity: 1 }, over);
  const head = b64u(JSON.stringify({ alg: "ES256", x5c: chain }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
  return head + "." + body + "." + b64u(sig);
}
function post(path, obj) {
  return new Promise((resolve) => {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: {} }));
    req.end(data);
  });
}

function startServer(env = {}) {
  const srv = spawn(process.execPath, [__dirname + "/servidor_salas.js"], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", IAP_ALLOW_TEST_ROOT: "1", IAP_TEST_ROOT_SHA256: TEST_ROOT_FP }, env),
  });
  srv.out = "";
  srv.stdout.on("data", (d) => (srv.out += d.toString()));
  srv.stderr.on("data", (d) => (srv.out += d.toString()));
  return srv;
}

function client(headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
    ws.msgs = [];
    ws.closedWith = null;
    ws.on("message", (d) => ws.msgs.push(JSON.parse(d.toString())));
    ws.j = (o) => ws.send(JSON.stringify(o));
    ws.last = (t) => [...ws.msgs].reverse().find((m) => m.t === t);
    ws.all = (t) => ws.msgs.filter((m) => m.t === t);
    ws.clear = () => (ws.msgs = []);
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (req, res) => { ws.status = res.statusCode; resolve(ws); });
    ws.on("error", () => resolve(ws));
    ws.on("close", (code) => (ws.closedWith = code));
  });
}

function get(path) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

const cmd = (i) => [((i * 37) % 2001) - 1000, ((i * 11) % 2001) - 1000, i % 16, (i * 7) % 300, -(i % 200)];

// sala con dos jugadores listos → partido empezado
async function pair(nameA = "Ana", nameB = "Beto") {
  const a = await client(), b = await client();
  a.j({ t: "create", proto: P, ver: VER, name: nameA, char: "nico", flag: "MX" });
  await sleep(80);
  const code = a.last("room").code;
  b.j({ t: "join", proto: P, ver: VER, code, name: nameB, char: "lia", flag: "AR" });
  await sleep(80);
  a.j({ t: "ready", v: true, rtt: 60 });
  b.j({ t: "ready", v: true, rtt: 90 });
  await sleep(120);
  return { a, b, code, st: a.last("start") };
}

(async () => {
  let srv = startServer();
  await sleep(700);

  console.log("\n[Salud y conexión]");
  const h = await get("/health");
  let hj = {};
  try { hj = JSON.parse(h.body); } catch (e) {}
  check(h.status === 200 && hj.ok === true && hj.proto === P && JSON.stringify(hj.protos) === "[2,3]" && typeof hj.boot === "string", "página de salud /health con protocolo 3 (acepta 2 y 3) y arranque");
  check((await get("/nada")).status === 404, "rutas desconocidas: 404");
  const a = await client(), b = await client(), c = await client();
  await sleep(100);
  check(a.last("hello") && a.last("hello").proto === 2 && a.last("hello").protos.includes(3), "saludo compatible: «proto 2» para el build anterior y «protos [2,3]» para el nuevo");

  console.log("\n[Salas: crear, unirse y errores]");
  a.j({ t: "create", proto: P, ver: VER, name: "Ana<script>", char: "nico", flag: "mx" });
  await sleep(100);
  const room = a.last("room");
  check(room && /^[A-HJ-NP-Z2-9]{5}$/.test(room.code) && room.you === 0 && room.tok.length === 24, "crear sala: código de 5 letras " + (room && room.code) + " y ficha privada");
  check(room.players[0].name === "Anascript" && room.players[0].flag === "MX", "nombre y bandera saneados");
  b.j({ t: "join", proto: P, ver: VER, code: "ZZZZZ", name: "Beto", char: "lia" });
  await sleep(80);
  check(b.last("error") && b.last("error").e === "no_room", "código que no existe: «no_room»");
  b.j({ t: "join", proto: P, ver: VER, code: "AB", name: "Beto", char: "lia" });
  await sleep(80);
  check(b.last("error").e === "bad_code", "código incompleto: «bad_code»");
  b.j({ t: "join", proto: P, ver: "0.3.16", code: room.code, name: "Beto", char: "lia" });
  await sleep(80);
  check(b.last("error").e === "version" && b.last("error").need === VER, "versiones distintas del juego: «version»");
  b.j({ t: "join", proto: 1, ver: VER, code: room.code, name: "Beto", char: "lia" });
  await sleep(80);
  check(b.last("error").e === "version" && b.last("error").server_proto === P, "protocolo 1 (muy viejo): «version»");
  b.j({ t: "join", proto: P, ver: VER, code: room.code.toLowerCase(), name: "Beto", char: "lia", flag: "AR" });
  await sleep(100);
  const rb = b.last("room");
  check(rb && rb.you === 1 && rb.players[0].name === "Anascript" && rb.players[1].name === "Beto" && rb.tok !== room.tok, "unirse (minúsculas valen): los dos se ven; cada uno con su ficha");
  check(!JSON.stringify(rb).includes(room.tok), "la ficha del anfitrión nunca llega al invitado");
  c.j({ t: "join", proto: P, ver: VER, code: room.code, name: "Caro", char: "kai" });
  await sleep(80);
  check(c.last("error").e === "full", "tercera persona: «full»");
  a.j({ t: "join", proto: P, ver: VER, code: room.code, name: "Ana", char: "nico" });
  await sleep(80);
  check(a.last("error").e === "own_room", "unirse a tu propia sala: «own_room»");
  a.j({ t: "hackear" });
  await sleep(60);
  check(a.last("error").e === "bad_msg", "mensaje desconocido: «bad_msg»");

  console.log("\n[E3.18 · mejoras en línea]");
  const ua = await client(), ub = await client();
  ua.j({ t: "create", proto: 3, ver: "u1", name: "Uno", char: "nico", flag: "MX", ups: { speed: 5, power: 2, control: 0, recharge: 1 } });
  await sleep(80);
  const ucode = ua.last("room").code;
  check(JSON.stringify(ua.last("room").players[0].ups) === JSON.stringify({ speed: 5, power: 2, control: 0, recharge: 1 }), "crear sala con niveles válidos (0..5): se guardan tal cual");
  ub.j({ t: "join", proto: 3, ver: "u1", code: ucode, name: "Dos", char: "lia", ups: { speed: 9, power: 2, control: 0, recharge: 1 } });
  await sleep(80);
  check(JSON.stringify(ua.last("room").players[1].ups) === JSON.stringify({ speed: 0, power: 0, control: 0, recharge: 0 }), "niveles fuera de rango (velocidad 9): el jugador queda SIN mejoras");
  ub.j({ t: "char", char: "kai", ups: { speed: 1.5, power: 0, control: 0, recharge: 0 } });
  await sleep(80);
  check(ub.last("error").e === "bad_ups" && JSON.stringify(ua.last("room").players[1].ups) === JSON.stringify({ speed: 0, power: 0, control: 0, recharge: 0 }), "decimales: rechazados («bad_ups»), sin mejoras");
  ub.j({ t: "char", char: "kai", ups: { speed: 1, power: 0, control: 0, recharge: 0, extra: 3 } });
  await sleep(80);
  check(JSON.stringify(ua.last("room").players[1].ups.speed) === "0", "claves de más: rechazadas");
  ub.j({ t: "char", char: "kai", ups: { speed: 4, power: 3, control: 2, recharge: 1 } });
  await sleep(80);
  check(ua.last("room").players[1].char === "kai" && ua.last("room").players[1].ups.power === 3, "cambiar de personaje manda los niveles de ESE personaje");
  ua.j({ t: "ready", v: true, rtt: 40 });
  ub.j({ t: "ready", v: true, rtt: 40 });
  await sleep(120);
  const us = ua.last("start"), us2 = ub.last("start");
  check(us && us2 && JSON.stringify(us.ups) === JSON.stringify(us2.ups) && us.ups[0].speed === 5 && us.ups[1].speed === 4,
    "el inicio lleva los niveles de los DOS jugadores, iguales en los dos teléfonos");
  ua.close(); ub.close();
  const oa = await client(), ob = await client();
  oa.j({ t: "create", proto: 2, ver: "old", name: "Viejo", char: "nico", ups: { speed: 5, power: 5, control: 5, recharge: 5 } });
  await sleep(80);
  ob.j({ t: "join", proto: 2, ver: "old", code: oa.last("room").code, name: "Viejo2", char: "lia" });
  await sleep(80);
  oa.j({ t: "ready", v: true, rtt: 40 });
  ob.j({ t: "ready", v: true, rtt: 40 });
  await sleep(120);
  check(oa.last("start") && oa.last("start").ups[0].speed === 0, "el build anterior (protocolo 2) sigue jugando, siempre sin mejoras en línea");
  oa.close(); ob.close();

  console.log("\n[E3.18 · verificación de compras]");
  const vj = makeJws();
  let r = await post("/iap/verify", { jws: vj, product: "com.eduardotoriello.tennispower.xp850" });
  check(r.status === 200 && r.json.verified === true && r.json.transactionId === "2000000123456789" && r.json.environment === "Sandbox" && r.json.revoked === false,
    "compra firmada correcta: verificada (transacción, producto y entorno)");
  r = await post("/iap/verify", { jws: vj, product: "com.eduardotoriello.tennispower.coins8000" });
  check(r.json.verified === false && r.json.reason === "producto", "la transacción es de otro paquete: rechazada");
  const parts = vj.split(".");
  const evilP = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  evilP.productId = "com.eduardotoriello.tennispower.xp3900";
  r = await post("/iap/verify", { jws: parts[0] + "." + b64u(JSON.stringify(evilP)) + "." + parts[2], product: "com.eduardotoriello.tennispower.xp3900" });
  check(r.json.verified === false && r.json.reason === "firma", "contenido alterado (otro paquete) con la firma original: rechazado");
  r = await post("/iap/verify", { jws: makeJws({ bundleId: "com.otra.app" }), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false && r.json.reason === "app", "compra de otra app: rechazada");
  r = await post("/iap/verify", { jws: makeJws({ type: "Non-Consumable" }), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false && r.json.reason === "tipo", "producto que no es consumible: rechazado");
  r = await post("/iap/verify", { jws: makeJws({ environment: "Xcode" }), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false && r.json.reason === "entorno", "entorno Xcode (archivo .storekit local): rechazado salvo que se active a propósito");
  r = await post("/iap/verify", { jws: makeJws({ revocationDate: Date.now() }), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === true && r.json.revoked === true, "compra reembolsada: verificada y marcada como reembolsada (el juego la retira)");
  const otherKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  r = await post("/iap/verify", { jws: makeJws({}, TEST_CHAIN, otherKey), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false && r.json.reason === "firma", "firmada con otra clave: rechazada");
  r = await post("/iap/verify", { jws: makeJws({}, [derB64("hoja_sin_oid.pem"), TEST_CHAIN[1], TEST_CHAIN[2]]), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false && (r.json.reason === "marca_apple" || r.json.reason === "firma"), "certificado sin la marca de Apple: rechazado");
  r = await post("/iap/verify", { jws: makeJws({}, [TEST_CHAIN[0], TEST_CHAIN[2], TEST_CHAIN[1]]), product: "com.eduardotoriello.tennispower.xp850" });
  check(r.json.verified === false, "cadena desordenada: rechazada");
  r = await post("/iap/verify", "{no es json");
  check(r.status === 400 && r.json.verified === false, "petición mal formada: 400");
  const noTest = verifyJws(vj, "com.eduardotoriello.tennispower.xp850", { bundleId: "com.eduardotoriello.tennispower" });
  check(noTest.verified === false && noTest.reason === "raiz", "SIN las variables de prueba, la raíz de prueba se rechaza (en Render solo vale Apple Root CA - G3)");
  check(APPLE_ROOT_G3_SHA256 === "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179", "huella fija de Apple Root CA - G3 (la publicada por Apple)");
  let lim = 0;
  for (let i = 0; i < 40; i++) {
    const x = await post("/iap/verify", { jws: "x", product: "" });
    if (x.status === 429) lim++;
  }
  check(lim > 0, "demasiadas verificaciones seguidas desde la misma IP: se frenan (429)");
  check(!srv.out.includes(vj.slice(0, 60)), "el registro del servidor no guarda las transacciones firmadas");

  console.log("\n[Preparación e inicio]");
  b.j({ t: "char", char: "dante" });
  await sleep(80);
  check(a.last("room").players[1].char === "dante", "cambiar de personaje actualiza la sala de los dos");
  a.j({ t: "ready", v: true, rtt: 50 });
  await sleep(80);
  a.j({ t: "char", char: "kai" });
  await sleep(80);
  check(a.last("room").players[0].char === "nico", "con LISTO puesto no se cambia de personaje");
  check(!a.last("start"), "con uno solo listo no empieza");
  b.j({ t: "ready", v: true, rtt: 110 });
  await sleep(120);
  const sa = a.last("start"), sb = b.last("start");
  check(sa && sb && sa.seed === sb.seed && sa.m === 1 && sa.you === 0 && sb.you === 1 && sa.chars[1] === "dante",
    `los dos listos: mismo inicio, partido nº ${sa && sa.m}, retardo ${sa && sa.delay} ticks`);
  const D = sa.delay;
  b.j({ t: "join", proto: P, ver: VER, code: room.code, name: "X", char: "nico" });
  await sleep(60);
  c.j({ t: "join", proto: P, ver: VER, code: room.code, name: "Caro", char: "kai" });
  await sleep(60);
  check(c.last("error").e === "in_game" || c.last("error").e === "full", "sala jugando: nadie más entra");

  console.log("\n[Entradas del partido: validación y orden]");
  b.clear();
  a.j({ t: "in", m: 1, k: D + 1, d: [cmd(1), cmd(2)] });
  await sleep(50);
  a.j({ t: "in", m: 1, k: D + 1, d: [cmd(1), cmd(2)] }); // duplicado
  a.j({ t: "in", m: 1, k: D + 2, d: [cmd(2), cmd(3)] }); // se solapa: solo pasa el tick D+3
  a.j({ t: "in", m: 1, k: D + 9, d: [cmd(9)] }); // hueco
  a.j({ t: "in", m: 0, k: D + 4, d: [cmd(4)] }); // de otro partido
  a.j({ t: "in", m: 1, k: D + 4, d: [[5000, 0, 0, 0, 0]] }); // fuera de rango
  a.j({ t: "in", m: 1, k: D + 4, d: [[1, 2, 3]] }); // forma incorrecta
  a.j({ t: "in", m: 1, k: D + 4, d: [[0.5, 0, 0, 0, 0]] }); // no entero
  await sleep(100);
  const ins = b.all("in");
  const ticks = [];
  ins.forEach((m) => m.d.forEach((_, i) => ticks.push(m.k + i)));
  check(ins.length === 2 && JSON.stringify(ticks) === JSON.stringify([D + 1, D + 2, D + 3]) && ins.every((m) => m.m === 1),
    "solo pasan entradas nuevas, en orden y del partido actual (duplicadas, huecos y atrasadas fuera): " + JSON.stringify(ticks));
  check(a.all("error").filter((e) => e.e === "bad_in").length === 3, "entradas mal formadas o fuera de rango: rechazadas («bad_in»)");
  a.j({ t: "in", m: 1, k: D + 4, d: Array.from({ length: 9 }, (_, i) => cmd(i)) });
  await sleep(60);
  check(a.last("error").e === "bad_in", "más de 8 ticks en un mensaje: rechazado");
  // el invitado sólo puede mandar huellas; el anfitrión sólo fotos
  a.clear();
  b.j({ t: "sync", m: 1, k: 30, h: 123456789 });
  b.j({ t: "sync", m: 1, k: 30, snap: "AAAA" });
  a.j({ t: "sync", m: 1, k: 30, snap: "QUJD" });
  a.j({ t: "sync", m: 1, k: 30, snap: "no es base64 !!" });
  await sleep(80);
  check(a.all("sync").length === 1 && a.last("sync").h === 123456789 && b.all("sync").filter((s) => s.snap === "QUJD").length === 1,
    "sincronía: huella invitado→anfitrión y foto anfitrión→invitado; lo demás se rechaza");
  // nadie puede adelantarse demasiado
  b.clear();
  let k = D + 4;
  for (let i = 0; i < 15; i++, k += 8) a.j({ t: "in", m: 1, k, d: Array.from({ length: 8 }, (_, j) => cmd(j)) });
  await sleep(120);
  const far = Math.max(...b.all("in").map((m) => m.k + m.d.length - 1));
  check(far <= D + 1 + 90 + 8, `el anfitrión no puede ir más de 90 ticks por delante del invitado (llegó hasta ${far})`);

  console.log("\n[Final por consenso]");
  a.j({ t: "end", m: 1, winner: 0, games: [2, 1], k: 5000, h: 42 });
  await sleep(80);
  check(!a.last("end") && !b.last("end"), "con un solo final todavía no hay resultado (se espera al otro juego)");
  a.j({ t: "end", m: 1, winner: 1, games: [0, 2], k: 5000, h: 42 });
  await sleep(60);
  b.j({ t: "end", m: 1, winner: 0, games: [2, 1], k: 5000, h: 42 });
  await sleep(100);
  const ea = a.last("end"), eb = b.last("end");
  check(ea && eb && ea.ok && eb.ok && ea.winner === 0 && eb.games.join("-") === "2-1" && ea.m === 1,
    "los dos coinciden: resultado confirmado a los dos (el segundo final del anfitrión se ignora)");
  b.j({ t: "end", m: 1, winner: 1, games: [0, 2], k: 5000, h: 42 });
  await sleep(60);
  check(b.all("end").length === 1, "el resultado se procesa una sola vez");
  a.j({ t: "in", m: 1, k: 99999, d: [cmd(1)] });
  await sleep(60);

  console.log("\n[Revancha]");
  a.j({ t: "rematch", v: true });
  await sleep(80);
  check(b.last("rematch") && b.last("rematch").who[0] === true && !b.all("start").some((s) => s.m === 2), "uno pide revancha: el otro se entera");
  b.j({ t: "rematch", v: true });
  await sleep(120);
  const s2 = a.last("start");
  check(s2 && s2.m === 2 && s2.seed !== sa.seed && b.last("start").m === 2, "los dos aceptan: partido nº 2 con otra semilla");
  b.clear();
  a.j({ t: "in", m: 1, k: s2.delay + 1, d: [cmd(1)] }); // mensaje atrasado del partido anterior
  a.j({ t: "in", m: 2, k: s2.delay + 1, d: [cmd(7)] });
  await sleep(80);
  check(b.all("in").length === 1 && b.last("in").m === 2 && b.last("in").d[0].join() === cmd(7).join(), "un mensaje del partido anterior no entra en la revancha");
  a.j({ t: "end", m: 2, winner: 0, games: [2, 0], k: 7000, h: 1 });
  b.j({ t: "end", m: 2, winner: 0, games: [2, 0], k: 7000, h: 2 }); // huellas distintas
  await sleep(100);
  check(a.last("end").void && a.last("end").reason === "mismatch" && b.last("end").void, "si los dos finales no coinciden: «sin resultado» para los dos");

  console.log("\n[Reconexión durante el partido]");
  a.j({ t: "rematch", v: true });
  b.j({ t: "rematch", v: true });
  await sleep(120);
  const s3 = a.last("start");
  const D3 = s3.delay;
  a.j({ t: "in", m: 3, k: D3 + 1, d: [cmd(1), cmd(2), cmd(3)] });
  b.j({ t: "in", m: 3, k: D3 + 1, d: [cmd(4), cmd(5)] });
  await sleep(80);
  const tokB = rb.tok;
  b.terminate(); // se cae la red del invitado
  await sleep(150);
  check(a.last("peer_wait") && a.last("peer_wait").secs === 20, "el anfitrión ve «tu rival se está reconectando» (se guarda su lugar 20 s)");
  a.j({ t: "in", m: 3, k: D3 + 4, d: [cmd(6), cmd(7)] }); // sigue mandando mientras el otro no está
  await sleep(60);
  const b2 = await client();
  b2.j({ t: "resume", proto: P, code: room.code, tok: "falsa", m: 3, rk: D3 + 1 });
  await sleep(80);
  check(b2.last("error").e === "resume_failed", "reconectar con una ficha falsa: no se permite");
  b2.clear();
  b2.j({ t: "resume", proto: P, code: room.code, tok: tokB, m: 3, rk: D3 + 1 });
  await sleep(120);
  const res = b2.last("resumed");
  const got = [];
  b2.all("in").forEach((m) => m.d.forEach((x, i) => got.push(m.k + i)));
  check(res && res.next_k === D3 + 3 && got.join() === [D3 + 1, D3 + 2, D3 + 3, D3 + 4, D3 + 5].join() && a.last("peer_back"),
    "vuelve con su ficha: recibe las entradas que se perdió y sabe desde qué tick reenviar las suyas");
  b2.j({ t: "in", m: 3, k: D3 + 1, d: [cmd(4), cmd(5), cmd(8)] }); // reenvía desde el principio: solo pasa lo nuevo
  await sleep(80);
  check(a.all("in").some((m) => m.k === D3 + 3 && m.d.length === 1 && m.d[0].join() === cmd(8).join()), "tras reconectar, lo reenviado no se duplica");

  console.log("\n[Abandono y desconexión]");
  const tokA = room.tok;
  a.terminate();
  await sleep(120);
  check(b2.last("peer_wait"), "si se cae el anfitrión también se le espera");
  srv.kill();
  await sleep(300);
  srv = startServer({ RESUME_MS: "600", HEARTBEAT_MS: "300" });
  await sleep(700);
  const ra = await client();
  ra.j({ t: "resume", proto: P, code: room.code, tok: tokA, m: 3, rk: 1 });
  await sleep(100);
  check(ra.last("error").e === "resume_failed" && ra.last("hello").boot !== hj.boot, "servidor reiniciado: la sala ya no existe y el juego lo sabe (otro «boot»)");
  ra.close();
  const p1 = await pair("Dani", "Eva");
  p1.b.terminate();
  await sleep(1000);
  check(p1.a.last("peer_wait") && p1.a.last("peer_left") && p1.a.last("end") && p1.a.last("end").void,
    "si el rival no vuelve a tiempo: «sin resultado» y aviso de que salió (nunca un resultado inventado)");
  p1.a.close();
  const p2 = await pair("Fer", "Gil");
  p2.b.j({ t: "leave" });
  await sleep(120);
  check(p2.a.last("peer_left") && p2.a.last("end").void, "abandonar a propósito: el otro se entera al momento");
  p2.a.close();
  // anfitrión sale antes de empezar
  const h1 = await client(), g1 = await client();
  h1.j({ t: "create", proto: P, ver: VER, name: "H", char: "nico" });
  await sleep(80);
  g1.j({ t: "join", proto: P, ver: VER, code: h1.last("room").code, name: "G", char: "lia" });
  await sleep(80);
  g1.j({ t: "ready", v: true, rtt: 50 });
  h1.close();
  await sleep(150);
  check(g1.last("room_closed"), "el anfitrión se va antes de empezar: la sala se cierra para el invitado");
  g1.close();
  // solo, no se puede estar listo
  const solo = await client();
  solo.j({ t: "create", proto: P, ver: VER, name: "S", char: "nico" });
  await sleep(80);
  solo.j({ t: "ready", v: true });
  await sleep(80);
  check(solo.last("room").players[0].ready === false, "sin rival nadie queda listo");
  solo.close();

  console.log("\n[Origen y límites]");
  srv.kill();
  await sleep(300);
  srv = startServer({ ALLOWED_ORIGINS: "https://juego.example", MAX_CONN_PER_IP: "6" });
  await sleep(700);
  const nat = await client();
  const web = await client({ Origin: "https://juego.example" });
  const evil = await client({ Origin: "https://otra.example" });
  await sleep(80);
  check(nat.readyState === 1 && web.readyState === 1 && evil.status === 403,
    "con filtro de origen: la app de iPhone (sin Origin) entra, la web permitida entra, una web ajena no");
  const many = [];
  for (let i = 0; i < 6; i++) many.push(await client());
  await sleep(80);
  check(many.filter((w) => w.readyState === 1).length === 4 && many.some((w) => w.status === 429), "límite de conexiones por IP");
  [nat, web, ...many].forEach((w) => w.close());
  await sleep(100);
  const guess = await client();
  for (let i = 0; i < 45; i++) guess.j({ t: "join", proto: P, ver: VER, code: "Q" + String(1000 + i).replace(/[01]/g, "Z").slice(0, 4), name: "x", char: "nico" });
  await sleep(200);
  check(guess.last("error").e === "too_many", "adivinar códigos a lo loco: se frena («too_many»)");
  guess.close();
  const fl = await client();
  for (let i = 0; i < 2000; i++) fl.j({ t: "ping", c: i });
  await sleep(200);
  check(fl.all("pong").length <= 245 && fl.closedWith === 1008, `exceso de mensajes por segundo: se cierra la conexión (${fl.all("pong").length} respuestas de 2000)`);
  fl.close();

  console.log("\n[Varias salas a la vez y tráfico real de un partido]");
  srv.kill();
  await sleep(300);
  srv = startServer({ MAX_CONN_PER_IP: "100" });
  await sleep(700);
  const N = 20;
  const pairs = [];
  for (let i = 0; i < N; i++) pairs.push(await pair("A" + i, "B" + i));
  check(new Set(pairs.map((p) => p.code)).size === N && pairs.every((p) => p.st && p.st.m === 1), `${N} salas a la vez, cada una con su código y su partido`);
  // 10 s de partido simulado a 60 ticks por segundo en cada sala (como el juego: una orden por cuadro)
  let bytesIn = 0, bytesOut = 0;
  pairs.forEach((p) => {
    p.a.on("message", (d) => (bytesIn += d.length));
    p.b.on("message", (d) => (bytesIn += d.length));
  });
  const cpuTicks = () => { try { const f = require("fs").readFileSync(`/proc/${srv.pid}/stat`, "utf8").split(") ")[1].split(" "); return +f[11] + +f[12]; } catch (e) { return -1; } };
  const c0 = cpuTicks();
  const t0 = Date.now();
  const SECS = 10;
  const ksA = pairs.map((p) => p.st.delay + 1), ksB = pairs.map((p) => p.st.delay + 1);
  for (let f = 0; f < SECS * 60; f++) {
    pairs.forEach((p, i) => {
      const ma = JSON.stringify({ t: "in", m: 1, k: ksA[i], d: [cmd(f)] });
      const mb = JSON.stringify({ t: "in", m: 1, k: ksB[i], d: [cmd(f + 3)] });
      bytesOut += ma.length + mb.length;
      p.a.send(ma);
      p.b.send(mb);
      ksA[i]++;
      ksB[i]++;
      if (f % 30 === 0) {
        const s = JSON.stringify({ t: "sync", m: 1, k: f + 1, h: 1234567890123 });
        bytesOut += s.length;
        p.b.send(s);
      }
    });
    const due = t0 + ((f + 1) * 1000) / 60;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
  const c1 = cpuTicks();
  const wall = (Date.now() - t0) / 1000;
  await sleep(300);
  const recv = pairs.map((p) => p.b.all("in").reduce((n, m) => n + m.d.length, 0));
  check(recv.every((n) => n === SECS * 60), `cada sala recibió exactamente sus ${SECS * 60} ticks del rival (sin mezclas entre salas)`);
  const perMatchOut = bytesIn / N / SECS; // lo que el servidor manda (por partido y segundo)
  const perMatchIn = bytesOut / N / SECS;
  const mbHour = (perMatchOut * 3600) / 1048576;
  console.log(`   medido: el servidor recibe ${(perMatchIn / 1024).toFixed(1)} KB/s y envía ${(perMatchOut / 1024).toFixed(1)} KB/s por partido (solo datos)`);
  console.log(`   ≈ ${mbHour.toFixed(1)} MB de salida por hora de partido (sin cabeceras TLS/TCP; con ellas ≈ ${(mbHour * 2.2).toFixed(0)} MB)`);
  if (c0 >= 0) console.log(`   CPU del servidor con ${N} partidos a la vez: ${(((c1 - c0) / 100) / wall * 100).toFixed(1)} % de un núcleo de esta máquina`);
  const cpu = await get("/health");
  console.log("   salud:", cpu.body);
  pairs.forEach((p) => { p.a.close(); p.b.close(); });
  await sleep(200);

  srv.kill();
  console.log(`\nPRUEBAS SERVIDOR: ${ok} correctas, ${bad} fallidas`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
