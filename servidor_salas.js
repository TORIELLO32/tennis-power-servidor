// TENNIS POWER · Servidor de salas privadas 1 contra 1 (E3.21 · protocolo 3, acepta también el 2)
// ---------------------------------------------------------------------------------------------
// Qué hace:
//   - Crea salas con un código de 5 letras, deja entrar a UNA segunda persona y avisa quién está.
//   - Guarda personaje y LISTO de cada jugador; cuando los dos están listos manda "start" a ambos
//     con la MISMA semilla, el mismo saque inicial, la misma cancha, el retardo de entradas y un
//     NÚMERO DE PARTIDO ("m"). Todo mensaje del partido lleva ese número: lo de un partido anterior
//     se descarta (nunca entra en la revancha).
//   - Durante el partido REVISA y reenvía las entradas (controles) de cada jugador al otro: tipo,
//     tamaño, rangos, número de partido y que el número de tick siga en orden (duplicados y atrasados
//     se descartan). Guarda las últimas entradas para poder RECONECTAR a quien perdió la red un momento.
//   - Resultado por CONSENSO: los dos juegos mandan su final (ganador, marcador, tick y huella). Si
//     coinciden, el servidor lo confirma a los dos; si no, el partido queda "sin resultado".
//     (No es una protección completa: el servidor no simula el partido. Ver LEEME_SERVIDOR.md.)
//   - Avisa al otro si alguien se desconecta (espera hasta RESUME_MS a que vuelva) o sale, y organiza
//     la REVANCHA cuando los dos aceptan.
//   - E3.18: cada jugador manda sus NIVELES de mejoras de multijugador (enteros 0..5 por atributo). El servidor
//     solo acepta enteros en ese rango y se los pasa a los dos juegos en "start"; cada juego calcula los mismos
//     multiplicadores con la misma tabla. (No puede saber si el jugador los compró: no hay cuentas.)
//   - E3.20: reenvía en cada "in" el campo opcional "a" (holgura, retardo y ping del que manda) para que el otro
//     juego ajuste su ritmo y su retardo de entrada en pleno partido (menos trabones). Juegos viejos lo ignoran.
//   - E3.21: POST /iap/claim y /iap/ack: entrega de compras con REGISTRO PERMANENTE (registro_compras.js, PostgreSQL).
//     Una transacción se entrega una sola vez y a un solo jugador. Sin base de datos configurada no autoriza entregas.
//   - E3.18: POST /iap/verify verifica compras de App Store firmadas por Apple (ver verificar_compras.js).
// No guarda nada en disco, no pide cuentas y no da monedas ni premios. Las salas viven en la memoria
// de ESTE proceso: si el servidor se reinicia, las salas y partidos en curso se pierden (los juegos
// lo dicen con claridad). Por eso debe correr UNA sola instancia.
//
// Uso local:   cd server && npm install && npm start          (escucha en el puerto 8090)
// Variables (todas opcionales; ver .env.example):
//   PORT              puerto (Render lo pone solo)
//   HOST              interfaz (0.0.0.0 por defecto, la que piden los alojamientos)
//   ALLOWED_ORIGINS   orígenes WEB permitidos, separados por comas. Las apps nativas (iPhone) no mandan
//                     cabecera Origin y SIEMPRE se aceptan: esto solo filtra páginas web ajenas.
//   MAX_ROOMS (300) · MAX_CONNECTIONS (400) · MAX_CONN_PER_IP (12)
// ---------------------------------------------------------------------------------------------
"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { verifyJws, optionsFromEnv } = require("./verificar_compras");
const compras = require("./registro_compras"); // E3.21: registro permanente de entregas

const PORT = parseInt(process.env.PORT || "8090", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || "300", 10);
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || "400", 10);
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP || "12", 10);
const PROTO = 3;                 // E3.18: + niveles de mejoras en línea ("ups")
const PROTOS = [2, 3];           // el 2 (build anterior) sigue funcionando: sus jugadores juegan sin mejoras en línea
const UP_ATTRS = ["speed", "power", "control", "recharge"];
const UP_MAX = 5;
const IAP_OPTS = optionsFromEnv(process.env);
const IAP_PER_MIN = parseInt(process.env.IAP_PER_MIN || "30", 10);
const BOOT = crypto.randomBytes(4).toString("hex"); // cambia en cada arranque (los juegos detectan reinicios)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin O/0 ni I/1 (fáciles de confundir)

const LOBBY_IDLE_MS = 30 * 60 * 1000;    // sala sin actividad en la espera
const ENDED_IDLE_MS = 10 * 60 * 1000;    // sala terminada sin revancha
const PLAY_IDLE_MS = 60 * 1000;          // partido sin ninguna entrada de nadie
const RESUME_MS = parseInt(process.env.RESUME_MS || "20000", 10); // cuánto se guarda el lugar de quien perdió la red
const END_WAIT_MS = 15 * 1000;           // espera por el final del otro juego
const INPUT_LOG = 1800;                  // entradas guardadas por jugador (30 s) para reconectar
const MAX_AHEAD = 90;                    // ticks que un jugador puede ir por delante del otro
const MAX_MSG_BYTES = 256 * 1024;
const MAX_SNAP_CHARS = 200 * 1024;
const MAX_MSGS_PER_SEC = parseInt(process.env.MAX_MSGS_PER_SEC || "240", 10); // el juego manda ~62 por segundo
const JOIN_FAILS_PER_10MIN = 40;         // intentos fallidos de código por IP (contra adivinar códigos)

const rooms = new Map(); // código -> sala
const perIp = new Map(); // ip -> conexiones abiertas
const joinFails = new Map(); // ip -> [marcas de tiempo]
const stats = { conns: 0, msgs: 0, bytesOut: 0, matches: 0, resumes: 0, rejected: 0 };

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// ------------------------------------------------------------------ utilidades y validación

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(n) {
  return String(n == null ? "JUGADOR" : n).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "JUGADOR";
}
function cleanFlag(s) {
  return String(s || "").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
}
function cleanId(s) {
  return String(s || "").replace(/[^a-z0-9_]/gi, "").slice(0, 24) || "nico";
}
function cleanVer(s) {
  return String(s || "").replace(/[^0-9A-Za-z._-]/g, "").slice(0, 20);
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// E3.18 · niveles de mejora en línea: exactamente {speed, power, control, recharge} con enteros 0..5.
// Cualquier otra cosa (decimales, negativos, más de 5, claves extra) se rechaza y el jugador queda sin mejoras.
function validUps(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return false;
  const keys = Object.keys(u);
  if (keys.length !== UP_ATTRS.length) return false;
  return UP_ATTRS.every((a) => isInt(u[a], 0, UP_MAX));
}
function zeroUps() {
  return { speed: 0, power: 0, control: 0, recharge: 0 };
}
function cleanUps(u) {
  if (!validUps(u)) return zeroUps();
  return { speed: u.speed, power: u.power, control: u.control, recharge: u.recharge };
}

// Una orden de un tick: [mx, my, flags, ax, ay] (enteros; ver LockstepSession.encode del juego).
function validCmd(a) {
  return Array.isArray(a) && a.length === 5 && isInt(a[0], -1000, 1000) && isInt(a[1], -1000, 1000) &&
    isInt(a[2], 0, 15) && isInt(a[3], -100000, 100000) && isInt(a[4], -100000, 100000);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    const s = JSON.stringify(obj);
    stats.bytesOut += s.length;
    ws.send(s);
  }
}

function clientIp(req) {
  // Render (y casi todos los alojamientos) ponen la IP real en x-forwarded-for
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "?";
}

function tooManyJoinFails(ip) {
  const now = Date.now();
  const arr = (joinFails.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  joinFails.set(ip, arr);
  return arr.length >= JOIN_FAILS_PER_10MIN;
}
function noteJoinFail(ip) {
  const arr = joinFails.get(ip) || [];
  arr.push(Date.now());
  joinFails.set(ip, arr);
}

// ------------------------------------------------------------------ salas

function roomInfo(room, you) {
  const me = room.players[you];
  return {
    t: "room",
    code: room.code,
    state: room.state,
    you,
    tok: me ? me.tok : "",
    m: room.match,
    players: room.players.map((p) =>
      p ? { name: p.name, char: p.char, flag: p.flag, ready: p.ready, connected: !!p.ws, ups: p.ups } : null
    ),
  };
}

function broadcastRoom(room) {
  room.players.forEach((p, i) => {
    if (p && p.ws) send(p.ws, roomInfo(room, i));
  });
}

function other(room, idx) {
  return room.players[1 - idx];
}

function newPlayer(ws, m) {
  const proto = m.proto === 3 ? 3 : 2;
  if (proto >= 3 && m.ups !== undefined && !validUps(m.ups)) stats.rejected += 1;
  return { ws, name: cleanName(m.name), char: cleanId(m.char), flag: cleanFlag(m.flag), ready: false, rtt: 80,
    tok: crypto.randomBytes(12).toString("hex"), gone: 0, proto, ups: proto >= 3 ? cleanUps(m.ups) : zeroUps() };
}

function startMatch(room) {
  const a = room.players[0];
  const b = room.players[1];
  room.state = "playing";
  room.match += 1;
  stats.matches += 1;
  room.rematch = [false, false];
  room.ends = [null, null];
  room.endTimer && clearTimeout(room.endTimer);
  room.endTimer = null;
  room.result = null;
  room.touched = Date.now();
  // Retardo de entradas (ticks de 1/60 s): lo que tarda una entrada en ir de un juego al otro
  // (≈ mitad del ping de cada uno al servidor) + margen para variaciones de la red.
  const oneWay = (Math.min(a.rtt, 1500) + Math.min(b.rtt, 1500)) / 2;
  const delay = Math.max(3, Math.min(15, Math.ceil((oneWay + 35) / (1000 / 60)) + 1));
  room.delay = delay;
  // registro de entradas por jugador (para reconectar): el primer tick con orden es delay + 1
  room.log = [{ base: delay + 1, d: [] }, { base: delay + 1, d: [] }];
  room.nextK = [delay + 1, delay + 1];
  const msg = {
    t: "start",
    m: room.match,
    match: room.match,
    seed: crypto.randomInt(1, 2147483646),
    first: crypto.randomInt(2),
    court_roll: crypto.randomInt(1000000),
    delay,
    chars: [a.char, b.char],
    names: [a.name, b.name],
    flags: [a.flag, b.flag],
    ups: [a.ups || zeroUps(), b.ups || zeroUps()],
  };
  room.startMsg = msg;
  log(`sala ${room.code}: partido ${room.match} (retardo ${delay} ticks, ping ${a.rtt}/${b.rtt} ms)`);
  send(a.ws, Object.assign({ you: 0 }, msg));
  send(b.ws, Object.assign({ you: 1 }, msg));
}

// Termina el partido actual (resultado confirmado o sin resultado) una sola vez.
function finishMatch(room, payload) {
  if (room.state !== "playing") return;
  room.state = "ended";
  room.result = payload;
  room.rematch = [false, false];
  room.touched = Date.now();
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = null;
  room.players.forEach((p) => p && p.ws && send(p.ws, Object.assign({ t: "end", m: room.match }, payload)));
  log(`sala ${room.code}: fin del partido ${room.match} → ${payload.void ? "sin resultado (" + payload.reason + ")" : "gana el jugador " + (payload.winner + 1)}`);
}

function closeRoom(room, why) {
  room.players.forEach((p) => {
    if (p && p.ws) {
      send(p.ws, { t: "room_closed", reason: why });
      p.ws.room = null;
    }
  });
  if (room.endTimer) clearTimeout(room.endTimer);
  room.players.forEach((p) => p && p.goneTimer && clearTimeout(p.goneTimer));
  rooms.delete(room.code);
  log(`sala ${room.code} cerrada (${why})`);
}

// El jugador idx deja la sala de verdad (salió, o no volvió a tiempo).
function dropPlayer(room, idx, reason) {
  const p = room.players[idx];
  if (!p) return;
  if (p.goneTimer) clearTimeout(p.goneTimer);
  if (p.ws) p.ws.room = null;
  room.players[idx] = null;
  room.touched = Date.now();
  const o = other(room, idx);
  if (room.state === "playing" || room.state === "ended") {
    const during = room.state;
    if (room.state === "playing") finishMatch(room, { void: true, reason: "peer_left" });
    room.rematch = [false, false];
    if (o && o.ws) send(o.ws, { t: "peer_left", during, reason });
  } else if (idx === 0) {
    // el anfitrión se fue antes de empezar: la sala se cierra
    closeRoom(room, "host_left");
    return;
  } else if (o) {
    o.ready = false;
    broadcastRoom(room);
  }
  if (!room.players[0] && !room.players[1]) {
    if (room.endTimer) clearTimeout(room.endTimer);
    rooms.delete(room.code);
    log(`sala ${room.code} vacía: eliminada`);
  }
}

// Se cerró la conexión (sin "leave"): durante un partido se guarda el lugar RESUME_MS.
function onDisconnect(ws) {
  const room = ws.room;
  if (!room) return;
  const idx = ws.idx;
  const p = room.players[idx];
  ws.room = null;
  if (!p || p.ws !== ws) return;
  if (room.state === "playing" && RESUME_MS > 0) {
    p.ws = null;
    p.gone = Date.now();
    const o = other(room, idx);
    if (o && o.ws) send(o.ws, { t: "peer_wait", secs: Math.round(RESUME_MS / 1000) });
    p.goneTimer = setTimeout(() => {
      if (room.players[idx] === p && !p.ws) dropPlayer(room, idx, "disconnect");
    }, RESUME_MS);
    log(`sala ${room.code}: el jugador ${idx + 1} perdió la conexión (se espera ${RESUME_MS / 1000} s)`);
    return;
  }
  dropPlayer(room, idx, "disconnect");
}

function attach(ws, room, idx) {
  ws.room = room;
  ws.idx = idx;
}

// ------------------------------------------------------------------ mensajes

function handleIn(ws, room, m) {
  if (room.state !== "playing" || m.m !== room.match) return; // de otro partido: se descarta
  if (!isInt(m.k, 1, 1e9) || !Array.isArray(m.d) || m.d.length < 1 || m.d.length > 8) return reject(ws, "bad_in");
  for (const a of m.d) if (!validCmd(a)) return reject(ws, "bad_in");
  const idx = ws.idx;
  let k = m.k;
  let d = m.d;
  const next = room.nextK[idx];
  if (k > next) {
    // hueco (no debería pasar en TCP): se ignora; tras reconectar se vuelve a mandar
    if (!room.gapLogged) log(`sala ${room.code}: hueco en las entradas del jugador ${idx + 1} (llegó ${k}, se esperaba ${next})`);
    room.gapLogged = true;
    return;
  }
  if (k + d.length <= next) return; // duplicado o atrasado
  if (k < next) {
    d = d.slice(next - k); // se solapa: solo lo nuevo
    k = next;
  }
  if (k - room.nextK[1 - idx] > MAX_AHEAD) {
    // nadie puede ir tan por delante del otro
    if (!room.aheadLogged) log(`sala ${room.code}: el jugador ${idx + 1} va demasiado por delante (${k} contra ${room.nextK[1 - idx]})`);
    room.aheadLogged = true;
    return;
  }
  const lg = room.log[idx];
  for (const a of d) lg.d.push(a);
  if (lg.d.length > INPUT_LOG) {
    const cut = lg.d.length - INPUT_LOG;
    lg.d.splice(0, cut);
    lg.base += cut;
  }
  room.nextK[idx] = k + d.length;
  room.touched = Date.now();
  const o = other(room, idx);
  const fwd = { t: "in", m: room.match, k, d };
  if (validReport(m.a)) fwd.a = m.a; // E3.20: holgura y retardo del que manda (el otro juego ajusta su ritmo)
  if (o && o.ws) send(o.ws, fwd);
}

// E3.20 · "a" = [holgura media ×10, holgura mala, retardo, ping] del juego que manda. Solo números enteros
// pequeños; si no tiene esa forma no se reenvía (el partido sigue igual, sin ese dato).
function validReport(a) {
  return Array.isArray(a) && a.length === 4 && isInt(a[0], -600, 600) && isInt(a[1], -60, 60) &&
    isInt(a[2], 2, 20) && isInt(a[3], 0, 5000);
}

function handleSync(ws, room, m) {
  if (room.state !== "playing" || m.m !== room.match || !isInt(m.k, 1, 1e9)) return;
  const o = other(room, ws.idx);
  if (ws.idx === 1) {
    // invitado → anfitrión: solo la huella de su estado
    if (!Number.isFinite(m.h) || !Number.isInteger(m.h)) return reject(ws, "bad_sync");
    if (o && o.ws) send(o.ws, { t: "sync", m: room.match, k: m.k, h: m.h });
  } else {
    // anfitrión → invitado: foto del estado (texto base64 acotado)
    if (typeof m.snap !== "string" || m.snap.length > MAX_SNAP_CHARS || !/^[A-Za-z0-9+/=]+$/.test(m.snap)) return reject(ws, "bad_sync");
    room.corrections = (room.corrections || 0) + 1;
    if (o && o.ws) send(o.ws, { t: "sync", m: room.match, k: m.k, snap: m.snap });
  }
}

function handleEnd(ws, room, m) {
  if (room.state !== "playing" || m.m !== room.match) return;
  const idx = ws.idx;
  if (room.ends[idx]) return; // una sola vez por jugador y partido
  if (!isInt(m.winner, 0, 1) || !Array.isArray(m.games) || m.games.length !== 2 ||
      !isInt(m.games[0], 0, 99) || !isInt(m.games[1], 0, 99) || !isInt(m.k, 1, 1e9) || !Number.isInteger(m.h)) {
    return reject(ws, "bad_end");
  }
  room.ends[idx] = { winner: m.winner, games: [m.games[0], m.games[1]], k: m.k, h: m.h };
  const [a, b] = room.ends;
  if (a && b) {
    const same = a.winner === b.winner && a.games[0] === b.games[0] && a.games[1] === b.games[1] && a.k === b.k && a.h === b.h;
    if (same) finishMatch(room, { ok: true, winner: a.winner, games: a.games });
    else finishMatch(room, { void: true, reason: "mismatch" });
    return;
  }
  // falta el otro juego: se le espera un poco (puede ir unos ticks atrás)
  if (!room.endTimer) {
    room.endTimer = setTimeout(() => finishMatch(room, { void: true, reason: "no_confirm" }), END_WAIT_MS);
  }
}

function handleResume(ws, m) {
  const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const r = rooms.get(code);
  if (!PROTOS.includes(m.proto)) return send(ws, { t: "error", e: "version", server_proto: PROTO });
  if (!r) return send(ws, { t: "error", e: "resume_failed", why: "no_room" });
  const idx = r.players.findIndex((p) => p && typeof m.tok === "string" && p.tok === m.tok);
  if (idx < 0) return send(ws, { t: "error", e: "resume_failed", why: "token" });
  const p = r.players[idx];
  if (p.ws && p.ws !== ws) {
    // la conexión vieja aún no se dio por cerrada: se reemplaza
    try { p.ws.room = null; p.ws.terminate(); } catch (e) {}
  }
  if (p.goneTimer) clearTimeout(p.goneTimer);
  p.goneTimer = null;
  p.ws = ws;
  p.gone = 0;
  if (ws.room && ws.room !== r) dropPlayer(ws.room, ws.idx, "left");
  attach(ws, r, idx);
  stats.resumes += 1;
  const o = other(r, idx);
  send(ws, roomInfo(r, idx));
  if (r.state !== "playing" || m.m !== r.match) {
    // el partido ya terminó (o es otro): se le dice cómo quedó
    send(ws, { t: "resumed", m: r.match, state: r.state, next_k: 0 });
    if (r.result) send(ws, Object.assign({ t: "end", m: r.match }, r.result));
    if (o && o.ws) send(o.ws, { t: "peer_back" });
    return;
  }
  // entradas del rival que se perdió mientras no estaba
  const rk = isInt(m.rk, 1, 1e9) ? m.rk : 1;
  const lg = r.log[1 - idx];
  if (rk < lg.base) {
    send(ws, { t: "error", e: "resume_failed", why: "too_old" });
    dropPlayer(r, idx, "resume_too_old");
    return;
  }
  send(ws, { t: "resumed", m: r.match, state: r.state, next_k: r.nextK[idx] });
  for (let k = rk; k < lg.base + lg.d.length; k += 60) {
    const from = k - lg.base;
    send(ws, { t: "in", m: r.match, k, d: lg.d.slice(from, from + 60) });
  }
  if (o && o.ws) send(o.ws, { t: "peer_back" });
  log(`sala ${r.code}: el jugador ${idx + 1} volvió a conectarse`);
}

function reject(ws, why) {
  stats.rejected += 1;
  ws._bad = (ws._bad || 0) + 1;
  if (ws._bad > 50) {
    log("conexión cerrada: demasiados mensajes inválidos");
    return ws.close(1008, "bad_messages");
  }
  send(ws, { t: "error", e: why });
}

function handle(ws, m) {
  const room = ws.room;
  switch (m.t) {
    case "ping":
      return send(ws, { t: "pong", c: Number.isFinite(m.c) ? m.c : 0 });
    case "in":
      return room && handleIn(ws, room, m);
    case "sync":
      return room && handleSync(ws, room, m);
    case "end":
      return room && handleEnd(ws, room, m);
    case "create": {
      if (!PROTOS.includes(m.proto)) return send(ws, { t: "error", e: "version", server_proto: PROTO });
      if (room) dropPlayer(room, ws.idx, "left");
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", e: "server_full" });
      const code = newCode();
      if (!code) return send(ws, { t: "error", e: "server_full" });
      const r = { code, ver: cleanVer(m.ver), state: "lobby", players: [null, null], match: 0,
        rematch: [false, false], ends: [null, null], touched: Date.now(), result: null, endTimer: null };
      r.players[0] = newPlayer(ws, m);
      rooms.set(code, r);
      attach(ws, r, 0);
      log(`sala ${code} creada (${rooms.size} salas)`);
      return broadcastRoom(r);
    }
    case "join": {
      if (tooManyJoinFails(ws.ip)) return send(ws, { t: "error", e: "too_many" });
      const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 5) return send(ws, { t: "error", e: "bad_code" });
      if (!PROTOS.includes(m.proto)) return send(ws, { t: "error", e: "version", server_proto: PROTO });
      const r = rooms.get(code);
      if (!r) {
        noteJoinFail(ws.ip);
        return send(ws, { t: "error", e: "no_room" });
      }
      if (r.players.some((p) => p && p.ws === ws)) return send(ws, { t: "error", e: "own_room" });
      if (cleanVer(m.ver) !== r.ver) return send(ws, { t: "error", e: "version", need: r.ver });
      if (r.state !== "lobby") return send(ws, { t: "error", e: "in_game" });
      const slot = r.players[0] ? (r.players[1] ? -1 : 1) : 0;
      if (slot < 0) return send(ws, { t: "error", e: "full" });
      if (room && room !== r) dropPlayer(room, ws.idx, "left");
      r.players[slot] = newPlayer(ws, m);
      r.touched = Date.now();
      attach(ws, r, slot);
      log(`sala ${code}: entró el jugador ${slot + 1}`);
      return broadcastRoom(r);
    }
    case "resume":
      return handleResume(ws, m);
    case "char": {
      if (!room || room.state !== "lobby") return;
      const p = room.players[ws.idx];
      if (!p || p.ready) return; // con LISTO puesto no se cambia de personaje
      p.char = cleanId(m.char);
      if (p.proto >= 3 && m.ups !== undefined) {
        if (!validUps(m.ups)) {
          p.ups = zeroUps();
          reject(ws, "bad_ups");
        } else p.ups = cleanUps(m.ups);
      }
      p.ready = false;
      room.touched = Date.now();
      return broadcastRoom(room);
    }
    case "ready": {
      if (!room || room.state !== "lobby") return;
      const p = room.players[ws.idx];
      if (!p) return;
      const both = room.players[0] && room.players[1];
      p.ready = !!m.v && !!both; // solo, nadie puede estar listo
      if (typeof m.rtt === "number" && m.rtt >= 0 && m.rtt < 5000) p.rtt = Math.round(m.rtt);
      room.touched = Date.now();
      broadcastRoom(room);
      if (both && room.players[0].ready && room.players[1].ready) startMatch(room);
      return;
    }
    case "rematch": {
      if (!room || room.state !== "ended" || !room.players[0] || !room.players[1] || !room.players[0].ws || !room.players[1].ws) {
        return send(ws, { t: "rematch", who: room ? room.rematch : [false, false], possible: false });
      }
      room.rematch[ws.idx] = !!m.v;
      room.touched = Date.now();
      room.players.forEach((p) => p && send(p.ws, { t: "rematch", who: room.rematch, possible: true }));
      if (room.rematch[0] && room.rematch[1]) startMatch(room);
      return;
    }
    case "rtt": {
      if (room && room.players[ws.idx] && typeof m.v === "number" && m.v >= 0 && m.v < 5000) room.players[ws.idx].rtt = Math.round(m.v);
      return;
    }
    case "leave":
      if (room) dropPlayer(room, ws.idx, "left");
      return;
    default:
      return reject(ws, "bad_msg");
  }
}

// ------------------------------------------------------------------ HTTP (salud) y WebSocket

// E3.18 · verificación de compras: límite de peticiones por IP y por minuto (contra abusos)
const iapHits = new Map(); // ip -> [marcas de tiempo]
function iapTooMany(ip) {
  const now = Date.now();
  const arr = (iapHits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  arr.push(now);
  iapHits.set(ip, arr);
  return arr.length > IAP_PER_MIN;
}

function iapReply(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

// Lee el cuerpo JSON (máx. 32 KB) y llama a fn(m) o responde el error.
function iapBody(req, res, fn) {
  if (iapTooMany(clientIp(req))) return iapReply(res, 429, { verified: false, reason: "demasiadas", retry: true });
  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    if (tooBig) return;
    body += c;
    if (body.length > 32 * 1024) tooBig = true;
  });
  req.on("end", () => {
    if (tooBig) return iapReply(res, 413, { verified: false, reason: "tamano" });
    let m;
    try {
      m = JSON.parse(body);
    } catch (e) {
      return iapReply(res, 400, { verified: false, reason: "formato" });
    }
    if (!m || typeof m !== "object") return iapReply(res, 400, { verified: false, reason: "formato" });
    Promise.resolve(fn(m)).catch((e) => {
      log("compra: registro no disponible (" + (e && e.code ? e.code : "error") + ")");
      iapReply(res, 503, { verified: false, reason: "registro_no_disponible", retry: true });
    });
  });
}

// E3.21 · registro permanente (se conecta al primer uso; si la base está dormida se reintenta en la siguiente)
const REG = compras.crearRegistro(process.env);
let regIniciando = null;
async function registro() {
  if (!REG) return null;
  if (REG.listo) return REG;
  if (!regIniciando) regIniciando = REG.iniciar().finally(() => (regIniciando = null));
  await regIniciando;
  return REG;
}

// E3.18 (builds 3 a 5): solo verifica. E3.21: si la transacción ya está en el registro como de otro jugador,
// responde que no se verifica (así un juego viejo no la acredita otra vez); si no está, la anota como
// entregada a "legado" (el juego viejo la acredita en ese momento) para que ningún juego nuevo la repita.
function handleVerify(req, res) {
  iapBody(req, res, async (m) => {
    const r = verifyJws(m.jws, typeof m.product === "string" ? m.product : "", IAP_OPTS);
    stats.iap = (stats.iap || 0) + 1;
    if (r.verified && REG) {
      const reg = await registro();
      const ya = await reg.obtener(r.transactionId);
      if (ya && ya.jugador !== "legado") {
        log(`compra (juego anterior): ya registrada, no se repite ${r.product} ${r.environment}`);
        return iapReply(res, 200, { verified: false, reason: "ya_registrada" });
      }
      const prod = compras.PRODUCTOS[r.product];
      if (!ya && prod) {
        await reg.reclamar({ transaction_id: r.transactionId, original_id: r.originalTransactionId || "", jugador: "legado", producto: r.product,
          tipo: prod.tipo, cantidad: prod.cantidad, entorno: r.environment, estado: r.revoked ? "reembolsada_sin_entregar" : "entregada", reembolsada: !!r.revoked });
      }
    }
    if (r.verified) stats.iapOk = (stats.iapOk || 0) + 1;
    // nunca se registra la transacción completa; solo el resultado
    log(`compra (juego anterior): ${r.verified ? "verificada" : "rechazada (" + r.reason + ")"}${r.verified ? " " + r.product + " " + r.environment : ""}`);
    return iapReply(res, 200, r);
  });
}

// E3.21 · POST /iap/claim {jws, player} → verifica con Apple (firma) y asigna la transacción a ese jugador.
// POST /iap/ack {jws, player, action: "entregada" | "reembolso_aplicado"} → el teléfono confirma que ya guardó.
function handleClaim(req, res, ack) {
  iapBody(req, res, async (m) => {
    const v = verifyJws(m.jws, "", IAP_OPTS);
    stats.iap = (stats.iap || 0) + 1;
    if (!v.verified) {
      log(`compra: rechazada (${v.reason})`);
      return iapReply(res, 200, v);
    }
    if (!REG) {
      // sin base de datos permanente no se autoriza ninguna entrega: el teléfono la deja pendiente y reintenta
      return iapReply(res, 503, { verified: true, ok: false, reason: "registro_sin_configurar", retry: true });
    }
    const reg = await registro();
    const out = ack ? await compras.confirmar(reg, v, String(m.player || ""), String(m.action || "")) : await compras.reclamar(reg, v, String(m.player || ""));
    if (out.ok && !ack) stats.iapOk = (stats.iapOk || 0) + 1;
    log(`compra: ${ack ? "confirmación" : "entrega"} ${v.product} ${v.environment} → ${out.ok ? out.state : out.reason}`);
    return iapReply(res, 200, out);
  });
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/" || path === "/health" || path === "/healthz") {
    // página de salud: Render la usa para saber que el servidor vive; el juego, para despertarlo
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true, juego: "TENNIS POWER", srv: "E3.21", proto: PROTO, protos: PROTOS, boot: BOOT,
      salas: rooms.size, conexiones: stats.conns, partidos: stats.matches, compras_verificadas: stats.iapOk || 0,
      registro_compras: REG ? (REG.listo ? REG.tipo : REG.tipo + " (conectando)") : "sin_configurar",
      uptime_s: Math.round(process.uptime()) }));
  }
  if (path === "/iap/verify" && req.method === "POST") return handleVerify(req, res);
  if (path === "/iap/claim" && req.method === "POST") return handleClaim(req, res, false);
  if (path === "/iap/ack" && req.method === "POST") return handleClaim(req, res, true);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("no");
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MSG_BYTES,
  perMessageDeflate: false,
  verifyClient: (info, done) => {
    if (stats.conns >= MAX_CONNECTIONS) return done(false, 503, "Servidor lleno");
    const ip = clientIp(info.req);
    if ((perIp.get(ip) || 0) >= MAX_CONN_PER_IP) return done(false, 429, "Demasiadas conexiones");
    // Las apps nativas no mandan Origin: se aceptan. El filtro solo frena páginas web ajenas.
    // (Origin NO es autenticación: cualquiera puede imitarlo.)
    const origin = info.origin || "";
    if (ALLOWED.length && origin && !ALLOWED.includes(origin)) return done(false, 403, "Origen no permitido");
    done(true);
  },
});

wss.on("connection", (ws, req) => {
  ws.ip = clientIp(req);
  perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
  stats.conns += 1;
  ws.isAlive = true;
  ws.room = null;
  ws.idx = -1;
  ws._count = 0;
  ws._window = Date.now();
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (data, isBinary) => {
    ws.isAlive = true;
    const now = Date.now();
    if (now - ws._window > 1000) {
      ws._window = now;
      ws._count = 0;
    }
    if (++ws._count > MAX_MSGS_PER_SEC) {
      // Demasiados mensajes: se CIERRA la conexión (ignorar sueltos dejaría huecos en las entradas).
      // Un juego normal manda ~62 por segundo; si de verdad era un juego, vuelve a la sala y reenvía.
      if (ws._count === MAX_MSGS_PER_SEC + 1) ws.close(1008, "flood");
      return;
    }
    if (isBinary) return;
    stats.msgs += 1;
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch (e) {
      return reject(ws, "bad_msg");
    }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.t !== "string") return reject(ws, "bad_msg");
    try {
      handle(ws, m);
    } catch (e) {
      log("error manejando mensaje", e && e.message);
    }
  });
  ws.on("close", () => {
    stats.conns -= 1;
    const n = (perIp.get(ws.ip) || 1) - 1;
    if (n <= 0) perIp.delete(ws.ip);
    else perIp.set(ws.ip, n);
    onDisconnect(ws);
  });
  ws.on("error", () => {});
  // "proto": 2 se conserva para que el build anterior (que exige 2) siga entrando; los nuevos leen "protos".
  send(ws, { t: "hello", proto: 2, protos: PROTOS, boot: BOOT });
});

// conexiones muertas (el teléfono se apagó sin cerrar): se detectan en ~20 s; salas caducadas
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
  const now = Date.now();
  for (const [, r] of rooms) {
    const idle = now - r.touched;
    if (r.state === "lobby" && idle > LOBBY_IDLE_MS) closeRoom(r, "expired");
    else if (r.state === "ended" && idle > ENDED_IDLE_MS) closeRoom(r, "expired");
    else if (r.state === "playing" && idle > PLAY_IDLE_MS) {
      finishMatch(r, { void: true, reason: "stalled" });
      closeRoom(r, "stalled");
    }
  }
}, parseInt(process.env.HEARTBEAT_MS || "10000", 10));

// resumen cada 10 min en los registros (para vigilar consumo en el panel del alojamiento)
const summary = setInterval(() => {
  log(`resumen: ${rooms.size} salas · ${stats.conns} conexiones · ${stats.matches} partidos · ${stats.msgs} mensajes · ` +
    `${(stats.bytesOut / 1048576).toFixed(1)} MB enviados · ${stats.resumes} reconexiones · ${stats.rejected} rechazados`);
}, 10 * 60 * 1000);
wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(summary);
});

function shutdown() {
  // reinicio o despliegue: se avisa a todos (las salas viven en memoria y se pierden)
  log("apagando: se cierran las salas");
  wss.clients.forEach((ws) => {
    try { ws.close(1012, "restart"); } catch (e) {}
  });
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => log(`TENNIS POWER · servidor de salas (protocolo ${PROTO}) escuchando en ${HOST}:${PORT} · registro de compras: ${REG ? REG.tipo : "SIN CONFIGURAR (no se entregan compras)"}`));

module.exports = { PROTO, PROTOS };
