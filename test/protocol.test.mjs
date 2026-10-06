import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import {
  aadFor,
  base64UrlToBytes,
  bootstrapUrl,
  bytesToBase64Url,
  createDesktopTransaction,
  decryptEnvelope
} from "../src/protocol.ts";

const infoV5 = new TextEncoder().encode("fill-from-phone/aes-gcm/v5");

async function phoneEncrypt(transaction, text) {
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  const desktop = await crypto.subtle.importKey("raw", base64UrlToBytes(transaction.bootstrap.publicKey), algorithm, false, []);
  const phone = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: algorithm.name, public: desktop }, phone.privateKey, 256));
  const aad = aadFor(transaction.bootstrap);
  const salt = await crypto.subtle.digest("SHA-256", aad);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: infoV5 }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(text);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext));
  plaintext.fill(0);
  return {
    v: transaction.bootstrap.v,
    phonePublicKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", phone.publicKey))),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext)
  };
}

test("phone and extension complete an authenticated round trip", async () => {
  const transaction = await createDesktopTransaction("https://accounts.example.com", 1_000);
  transaction.bootstrap.slot = "B";
  assert.equal(transaction.bootstrap.v, 5);
  assert.equal(base64UrlToBytes(transaction.bootstrap.id).length, 32);
  assert.equal(base64UrlToBytes(transaction.bootstrap.publicKey).length, 65);
  assert.equal(transaction.privateKey.extractable, false);
  const envelope = await phoneEncrypt(transaction, "correct horse battery staple");
  const plaintext = await decryptEnvelope(transaction, envelope);
  assert.equal(new TextDecoder().decode(plaintext), "correct horse battery staple");
  plaintext.fill(0);
});

test("QR URL uses an exact 256-bit route and no common /f endpoint", async () => {
  const transaction = await createDesktopTransaction("https://accounts.example.com", 1_000);
  transaction.bootstrap.slot = "G";
  const url = new URL(bootstrapUrl("https://fillfromphone.com", transaction.bootstrap));
  assert.match(url.pathname, /^\/t\/[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.pathname.slice(3), transaction.bootstrap.id);
  assert.ok(url.hash.length > 1);
  const symbol = QRCode.create(url.href, { errorCorrectionLevel: "M" });
  const renderedModules = symbol.modules.size + 8;
  assert.ok(320 / renderedModules >= 3, "the displayed symbol must retain at least three pixels per QR module including quiet zone");
});

test("origin substitution and ciphertext tampering fail authentication", async () => {
  const transaction = await createDesktopTransaction("https://accounts.example.com", 1_000);
  transaction.bootstrap.slot = "B";
  const envelope = await phoneEncrypt(transaction, "secret");
  transaction.bootstrap.origin = "https://evil.example";
  await assert.rejects(() => decryptEnvelope(transaction, envelope));

  const clean = await createDesktopTransaction("https://accounts.example.com", 1_000);
  clean.bootstrap.slot = "G";
  const tampered = await phoneEncrypt(clean, "secret");
  const bytes = base64UrlToBytes(tampered.ciphertext);
  bytes[0] ^= 1;
  tampered.ciphertext = bytesToBase64Url(bytes);
  await assert.rejects(() => decryptEnvelope(clean, tampered));
});

test("short, long, and password field classifications are authenticated", async () => {
  for (const [fieldKind, replacement] of [["short-text", "long-text"], ["long-text", "password"], ["password", "short-text"]]) {
    const transaction = await createDesktopTransaction("https://accounts.example.com", 1_000, fieldKind);
    transaction.bootstrap.slot = "B";
    assert.equal(transaction.bootstrap.fieldKind, fieldKind);
    const envelope = await phoneEncrypt(transaction, "synthetic-value");
    transaction.bootstrap.fieldKind = replacement;
    await assert.rejects(() => decryptEnvelope(transaction, envelope));
  }
});

test("non-local plaintext destination origins are rejected", async () => {
  await assert.rejects(() => createDesktopTransaction("http://accounts.example.com", 1_000), /insecure destination origin/u);
  const local = await createDesktopTransaction("http://localhost:8080", 1_000);
  assert.equal(local.bootstrap.origin, "http://localhost:8080");
});
