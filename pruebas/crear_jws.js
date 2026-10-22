// SOLO PRUEBAS · Crea una transacción firmada con la cadena DE PRUEBA (misma forma que las de StoreKit 2).
// Uso: node pruebas/crear_jws.js <productId> <transactionId> [Sandbox|Production|Xcode] [revocada:0|1]
// Imprime la transacción (JWS) en una línea y, en otra, la huella de la raíz de prueba.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const T = __dirname + "/";
const der = (pem) => new crypto.X509Certificate(fs.readFileSync(T + pem)).raw;
const chain = ["hoja_prueba.pem", "intermedio_prueba.pem", "raiz_prueba.pem"].map((p) => der(p).toString("base64"));
const key = crypto.createPrivateKey(fs.readFileSync(T + "hoja_prueba.key"));
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const [product, tx, env, revoked] = process.argv.slice(2);
const payload = { transactionId: tx || "2000000000000001", originalTransactionId: tx || "2000000000000001",
  bundleId: "com.eduardotoriello.tennispower", productId: product || "com.eduardotoriello.tennispower.coins500",
  type: "Consumable", environment: env || "Sandbox", purchaseDate: Date.now() - 1000, signedDate: Date.now(), quantity: 1 };
if (revoked === "1") payload.revocationDate = Date.now();
const head = b64u(JSON.stringify({ alg: "ES256", x5c: chain }));
const body = b64u(JSON.stringify(payload));
const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
console.log(head + "." + body + "." + b64u(sig));
console.log(crypto.createHash("sha256").update(der("raiz_prueba.pem")).digest("hex").toUpperCase());
