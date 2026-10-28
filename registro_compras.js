// TENNIS POWER · Registro PERMANENTE de compras (E3.21)
// ---------------------------------------------------------------------------------------------
// Para qué sirve: que cada compra de App Store se entregue UNA sola vez, a UN solo jugador, aunque se
// cierre la app a la mitad, se reinstale, se restaure un respaldo viejo o el mismo Apple ID juegue en
// otro teléfono. El teléfono sigue guardando su propio registro, pero el que manda es este.
//
// Dónde se guarda:
//   · DATABASE_URL  → PostgreSQL (en Render: una base GRATIS externa, p. ej. Neon; ver GUIA_RENDER.md).
//                     Es lo único que vale para el servidor público: el disco del plan gratis de Render
//                     se BORRA en cada reinicio, así que ahí nunca se usa un archivo.
//   · IAP_LEDGER_FILE → archivo local (SOLO pruebas en una computadora; se niega a funcionar en Render).
//   · ninguna        → "sin configurar": el servidor verifica, pero NO autoriza entregas (el teléfono
//                     deja la compra pendiente y la reintenta; no se pierde).
//
// Contenido de cada producto: tabla FIJA por identificador de Apple. Un identificador nunca cambia de
// contenido: si un paquete cambia de cantidad, se crea otro identificador (por eso xp300 sigue valiendo
// 300 XP para siempre aunque hoy se venda xp500). El contenido se copia en la fila de la transacción al
// registrarla, así que ni un cambio futuro de esta tabla altera compras ya registradas.
//
// Estados de una transacción:
//   reclamada               asignada a un jugador; su teléfono debe acreditarla y avisar ("entregada")
//   entregada               el teléfono confirmó que la guardó; NUNCA se vuelve a entregar
//   reembolso_pendiente     Apple la reembolsó después de entregarla; el teléfono debe retirarla
//   reembolso_aplicado      el teléfono confirmó que la retiró
//   reembolsada_sin_entregar Apple la reembolsó antes de entregarla: no se entrega nada
"use strict";
const fs = require("fs");
const path = require("path");

const PREFIX = "com.eduardotoriello.tennispower.";
// Contenido por identificador de Apple (NO cambiar el de uno existente: crear otro identificador).
const PRODUCTOS = Object.freeze({
  [PREFIX + "coins500"]: { tipo: "coins", cantidad: 500 },
  [PREFIX + "coins1400"]: { tipo: "coins", cantidad: 1400 },
  [PREFIX + "coins3200"]: { tipo: "coins", cantidad: 3200 },
  [PREFIX + "coins8000"]: { tipo: "coins", cantidad: 8000 },
  // E3.21 · paquetes de XP vigentes
  [PREFIX + "xp500"]: { tipo: "xp", cantidad: 500 },
  [PREFIX + "xp1500"]: { tipo: "xp", cantidad: 1500 },
  [PREFIX + "xp3200"]: { tipo: "xp", cantidad: 3200 },
  [PREFIX + "xp7500"]: { tipo: "xp", cantidad: 7500 },
  // E3.18–E3.20 · paquetes de XP anteriores: ya no se venden, pero una compra hecha con ellos
  // (por ejemplo en Sandbox) se entrega con SU contenido de entonces, nunca con el nuevo.
  [PREFIX + "xp300"]: { tipo: "xp", cantidad: 300, retirado: true },
  [PREFIX + "xp850"]: { tipo: "xp", cantidad: 850, retirado: true },
  [PREFIX + "xp1700"]: { tipo: "xp", cantidad: 1700, retirado: true },
  [PREFIX + "xp3900"]: { tipo: "xp", cantidad: 3900, retirado: true },
});

const JUGADOR_RE = /^[0-9a-f]{32}$/;
const ESTADOS = ["reclamada", "entregada", "reembolso_pendiente", "reembolso_aplicado", "reembolsada_sin_entregar"];

function ahora() {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ almacenamiento: PostgreSQL

class RegistroPostgres {
  constructor(url, poolFactory) {
    this.tipo = "postgres";
    const { Pool } = poolFactory || require("pg");
    // Neon y casi todos los alojamientos exigen TLS: si la dirección no lo dice, se pide.
    const ssl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: true };
    this.pool = new Pool({ connectionString: url, ssl, max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
    this.pool.on("error", () => {}); // una conexión inactiva cerrada por el proveedor no tumba el servidor
    this.listo = false;
  }

  async iniciar() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS compras (
      transaction_id TEXT PRIMARY KEY,
      original_id TEXT NOT NULL DEFAULT '',
      jugador TEXT NOT NULL,
      producto TEXT NOT NULL,
      tipo TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      entorno TEXT NOT NULL,
      estado TEXT NOT NULL,
      reembolsada BOOLEAN NOT NULL DEFAULT FALSE,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizada TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.pool.query("CREATE INDEX IF NOT EXISTS compras_jugador ON compras (jugador)");
    this.listo = true;
  }

  // Inserta la fila si no existe y devuelve la que quedó (la nueva o la que ya estaba). Atómico.
  async reclamar(fila) {
    const r = await this.pool.query(
      `INSERT INTO compras (transaction_id, original_id, jugador, producto, tipo, cantidad, entorno, estado, reembolsada)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (transaction_id) DO NOTHING RETURNING *`,
      [fila.transaction_id, fila.original_id, fila.jugador, fila.producto, fila.tipo, fila.cantidad, fila.entorno, fila.estado, fila.reembolsada]
    );
    if (r.rows.length) return { fila: limpiar(r.rows[0]), nueva: true };
    return { fila: await this.obtener(fila.transaction_id), nueva: false };
  }

  async obtener(tx) {
    const r = await this.pool.query("SELECT * FROM compras WHERE transaction_id = $1", [tx]);
    return r.rows.length ? limpiar(r.rows[0]) : null;
  }

  // Cambia de estado SOLO si está en uno de los esperados (evita carreras entre dos teléfonos).
  async cambiar(tx, desde, hacia, reembolsada) {
    const r = await this.pool.query(
      `UPDATE compras SET estado = $2, reembolsada = reembolsada OR $4, actualizada = now()
       WHERE transaction_id = $1 AND estado = ANY($3::text[]) RETURNING *`,
      [tx, hacia, desde, !!reembolsada]
    );
    return r.rows.length ? limpiar(r.rows[0]) : await this.obtener(tx);
  }

  async contar() {
    const r = await this.pool.query("SELECT estado, entorno, count(*)::int AS n FROM compras GROUP BY estado, entorno");
    return r.rows;
  }

  async cerrar() {
    await this.pool.end();
  }
}

function limpiar(r) {
  return {
    transaction_id: String(r.transaction_id),
    original_id: String(r.original_id || ""),
    jugador: String(r.jugador),
    producto: String(r.producto),
    tipo: String(r.tipo),
    cantidad: Number(r.cantidad),
    entorno: String(r.entorno),
    estado: String(r.estado),
    reembolsada: !!r.reembolsada,
  };
}

// ------------------------------------------------------------------ almacenamiento: archivo (SOLO pruebas locales)

class RegistroArchivo {
  constructor(ruta) {
    this.tipo = "archivo";
    this.ruta = ruta;
    this.filas = new Map();
    this.listo = false;
  }

  async iniciar() {
    if (process.env.RENDER) throw new Error("IAP_LEDGER_FILE no se permite en Render (su disco se borra al reiniciar)");
    fs.mkdirSync(path.dirname(this.ruta), { recursive: true });
    if (fs.existsSync(this.ruta)) {
      // registro de solo-agregar: cada línea es la fila completa tras un cambio; gana la última
      for (const linea of fs.readFileSync(this.ruta, "utf8").split("\n")) {
        if (!linea.trim()) continue;
        try {
          const f = JSON.parse(linea);
          if (f && f.transaction_id) this.filas.set(f.transaction_id, f);
        } catch (e) {
          // una última línea cortada (apagón) se ignora: la fila anterior sigue valiendo
        }
      }
    }
    this.listo = true;
  }

  _escribir(f) {
    const fd = fs.openSync(this.ruta, "a");
    try {
      fs.writeSync(fd, JSON.stringify(f) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  async reclamar(fila) {
    const ya = this.filas.get(fila.transaction_id);
    if (ya) return { fila: { ...ya }, nueva: false };
    const f = { ...fila };
    this._escribir(f);
    this.filas.set(f.transaction_id, f);
    return { fila: { ...f }, nueva: true };
  }

  async obtener(tx) {
    const f = this.filas.get(tx);
    return f ? { ...f } : null;
  }

  async cambiar(tx, desde, hacia, reembolsada) {
    const f = this.filas.get(tx);
    if (!f) return null;
    if (!desde.includes(f.estado)) return { ...f };
    const n = { ...f, estado: hacia, reembolsada: f.reembolsada || !!reembolsada };
    this._escribir(n);
    this.filas.set(tx, n);
    return { ...n };
  }

  async contar() {
    const c = {};
    for (const f of this.filas.values()) {
      const k = f.estado + "|" + f.entorno;
      c[k] = (c[k] || 0) + 1;
    }
    return Object.entries(c).map(([k, n]) => ({ estado: k.split("|")[0], entorno: k.split("|")[1], n }));
  }

  async cerrar() {}
}

// ------------------------------------------------------------------ reglas

function crearRegistro(env) {
  const e = env || process.env;
  if (e.DATABASE_URL) return new RegistroPostgres(e.DATABASE_URL);
  if (e.IAP_LEDGER_FILE) return new RegistroArchivo(e.IAP_LEDGER_FILE);
  return null;
}

function respuesta(f, extra) {
  return Object.assign(
    {
      verified: true,
      ok: true,
      transactionId: f.transaction_id,
      product: f.producto,
      environment: f.entorno,
      grant: { kind: f.tipo, amount: f.cantidad },
      state: f.estado,
      revoked: f.reembolsada,
    },
    extra || {}
  );
}

// Reclama una transacción YA VERIFICADA (resultado de verifyJws) para un jugador.
// Devuelve lo que el teléfono debe hacer según el estado guardado.
async function reclamar(reg, v, jugador) {
  if (!JUGADOR_RE.test(String(jugador || ""))) return { verified: true, ok: false, reason: "jugador" };
  const prod = PRODUCTOS[v.product];
  if (!prod) return { verified: true, ok: false, reason: "producto_desconocido" };
  const { fila } = await reg.reclamar({
    transaction_id: v.transactionId,
    original_id: String(v.originalTransactionId || ""),
    jugador,
    producto: v.product,
    tipo: prod.tipo,
    cantidad: prod.cantidad,
    entorno: v.environment,
    estado: v.revoked ? "reembolsada_sin_entregar" : "reclamada",
    reembolsada: !!v.revoked,
  });
  if (!fila) return { verified: true, ok: false, reason: "registro", retry: true };
  if (fila.jugador !== jugador) {
    // ya es de otro jugador (otro teléfono con el mismo Apple ID, o un progreso distinto): aquí no se entrega
    return { verified: true, ok: false, reason: "otro_jugador", transactionId: fila.transaction_id, product: fila.producto };
  }
  let f = fila;
  if (v.revoked && !f.reembolsada) {
    // Apple avisa de un reembolso
    if (f.estado === "entregada") f = await reg.cambiar(f.transaction_id, ["entregada"], "reembolso_pendiente", true);
    else if (f.estado === "reclamada") f = await reg.cambiar(f.transaction_id, ["reclamada"], "reembolsada_sin_entregar", true);
  }
  return respuesta(f);
}

// El teléfono confirma: "entregada" (ya guardó lo acreditado) o "reembolso_aplicado" (ya lo retiró).
async function confirmar(reg, v, jugador, accion) {
  if (!JUGADOR_RE.test(String(jugador || ""))) return { verified: true, ok: false, reason: "jugador" };
  const f = await reg.obtener(v.transactionId);
  if (!f) return { verified: true, ok: false, reason: "no_reclamada" };
  if (f.jugador !== jugador) return { verified: true, ok: false, reason: "otro_jugador" };
  let n = f;
  if (accion === "entregada") n = await reg.cambiar(f.transaction_id, ["reclamada"], "entregada", false);
  else if (accion === "reembolso_aplicado") n = await reg.cambiar(f.transaction_id, ["reembolso_pendiente"], "reembolso_aplicado", true);
  else return { verified: true, ok: false, reason: "accion" };
  return respuesta(n);
}

module.exports = { PRODUCTOS, ESTADOS, JUGADOR_RE, crearRegistro, reclamar, confirmar, RegistroPostgres, RegistroArchivo, ahora };
