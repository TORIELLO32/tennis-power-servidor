// TENNIS POWER · Verificación de compras de App Store (StoreKit 2) · E3.18
// ---------------------------------------------------------------------------------------------
// El juego (iPhone) recibe de StoreKit la transacción FIRMADA por Apple (JWS, "jwsRepresentation") y la
// manda aquí antes de acreditar monedas o experiencia. Este módulo comprueba, sin claves secretas:
//   1. Formato JWS compacto, algoritmo ES256 y cadena x5c de 3 certificados (hoja, intermedio, raíz).
//   2. Que la raíz sea EXACTAMENTE "Apple Root CA - G3" (huella SHA-256 fija, publicada por Apple en
//      https://support.apple.com/en-am/121672).
//   3. Que cada certificado esté firmado por el siguiente y vigente en la fecha de firma de la transacción.
//   4. Las marcas de Apple: la hoja lleva el OID 1.2.840.113635.100.6.11.1 y el intermedio el
//      1.2.840.113635.100.6.2.1 (las mismas que comprueba la librería oficial de Apple).
//   5. La firma ES256 del JWS con la clave de la hoja.
//   6. El contenido: bundleId de la app, producto pedido, tipo consumible, entorno (Sandbox/Production),
//      identificador de transacción y si fue reembolsada (revocationDate).
// No consulta a Apple por internet (sin OCSP): la firma de Apple ya garantiza que la transacción es real.
// Nunca acredita nada por sí mismo: solo responde verified true/false. El teléfono acredita una sola vez
// por transactionId (y guarda la lista en su progreso).
"use strict";
const crypto = require("crypto");

const APPLE_ROOT_G3_SHA256 = "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179";
const OID_LEAF = Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01]);
const OID_INTER = Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01]);
const MAX_JWS = 20000;

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function fingerprint(der) {
  return crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
}

// Opciones (todas por variables de entorno en el servidor; ver .env.example):
//   bundleId        com.eduardotoriello.tennispower
//   appAppleId      número de la app en App Store Connect (solo se exige en Production si se configura)
//   allowXcode      acepta el entorno "Xcode" (pruebas locales con archivo .storekit) · por defecto NO
//   testRootSha256  huella de una raíz de PRUEBA (solo si allowTestRoot) · nunca en Render
function verifyJws(jws, wantProduct, opts) {
  const o = opts || {};
  const fail = (reason) => ({ verified: false, reason });
  if (typeof jws !== "string" || jws.length < 20 || jws.length > MAX_JWS) return fail("formato");
  const parts = jws.split(".");
  if (parts.length !== 3) return fail("formato");
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  } catch (e) {
    return fail("formato");
  }
  if (!header || header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) return fail("cabecera");
  let leaf, inter, root;
  try {
    [leaf, inter, root] = header.x5c.map((c) => new crypto.X509Certificate(Buffer.from(String(c), "base64")));
  } catch (e) {
    return fail("certificados");
  }
  const rootFp = fingerprint(root.raw);
  const roots = [APPLE_ROOT_G3_SHA256];
  if (o.allowTestRoot && o.testRootSha256) roots.push(String(o.testRootSha256).replace(/:/g, "").toUpperCase());
  if (!roots.includes(rootFp)) return fail("raiz");
  try {
    if (!root.verify(root.publicKey)) return fail("raiz");
    if (!inter.checkIssued(root) || !inter.verify(root.publicKey)) return fail("cadena");
    if (!leaf.checkIssued(inter) || !leaf.verify(inter.publicKey)) return fail("cadena");
  } catch (e) {
    return fail("cadena");
  }
  if (!leaf.raw.includes(OID_LEAF) || !inter.raw.includes(OID_INTER)) return fail("marca_apple");
  // vigencia de los certificados en la fecha en que Apple firmó la transacción
  const when = Number.isFinite(payload.signedDate) ? payload.signedDate : Date.now();
  for (const c of [leaf, inter, root]) {
    if (when < Date.parse(c.validFrom) || when > Date.parse(c.validTo)) return fail("vigencia");
  }
  // firma ES256 (r||s de 64 bytes)
  let okSig = false;
  try {
    okSig = crypto.verify("sha256", Buffer.from(parts[0] + "." + parts[1]), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
      b64urlToBuf(parts[2]));
  } catch (e) {
    okSig = false;
  }
  if (!okSig) return fail("firma");
  // contenido
  if (o.bundleId && payload.bundleId !== o.bundleId) return fail("app");
  if (!payload.transactionId) return fail("transaccion");
  if (wantProduct && payload.productId !== wantProduct) return fail("producto");
  if (o.productPrefix && !String(payload.productId || "").startsWith(o.productPrefix)) return fail("producto");
  if (payload.type && payload.type !== "Consumable") return fail("tipo");
  const env = String(payload.environment || "");
  const envOk = env === "Sandbox" || env === "Production" || (env === "Xcode" && o.allowXcode);
  if (!envOk) return fail("entorno");
  if (env === "Production" && o.appAppleId && String(payload.appAppleId || "") !== String(o.appAppleId)) return fail("app");
  return {
    verified: true,
    product: payload.productId,
    transactionId: String(payload.transactionId),
    environment: env,
    revoked: payload.revocationDate != null,
  };
}

function optionsFromEnv(env) {
  const e = env || process.env;
  const bundleId = e.IAP_BUNDLE_ID || "com.eduardotoriello.tennispower";
  return {
    bundleId,
    productPrefix: bundleId + ".",
    appAppleId: e.IAP_APP_APPLE_ID || "",
    allowXcode: e.IAP_ALLOW_XCODE === "1",
    allowTestRoot: e.IAP_ALLOW_TEST_ROOT === "1",
    testRootSha256: e.IAP_TEST_ROOT_SHA256 || "",
  };
}

module.exports = { verifyJws, optionsFromEnv, APPLE_ROOT_G3_SHA256, MAX_JWS };
