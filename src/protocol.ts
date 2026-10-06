export const SESSION_TTL_MS = 120_000;
export const MAX_PLAINTEXT_BYTES = 65_536;
const INFO_V5 = new TextEncoder().encode("fill-from-phone/aes-gcm/v5");
export type FieldKind = "short-text" | "long-text" | "password";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export interface Bootstrap {
  v: 5;
  slot?: "B" | "G";
  id: string;
  publicKey: string;
  challenge: string;
  expiresAt: number;
  origin: string;
  writeToken: string;
  fieldKind: FieldKind;
}

export interface Envelope {
  v: 5;
  phonePublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface DesktopTransaction {
  bootstrap: Bootstrap;
  privateKey: CryptoKey;
  readToken: string;
  readTokenHash: string;
  writeTokenHash: string;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(base64UrlToBytes(token)));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function aadFor(bootstrap: Pick<Bootstrap, "v" | "slot" | "id" | "challenge" | "expiresAt" | "origin" | "fieldKind">): Uint8Array {
  if (bootstrap.slot !== "B" && bootstrap.slot !== "G") throw new Error("missing deployment slot");
  const context: Array<string | number> = [bootstrap.v, bootstrap.slot, bootstrap.id, bootstrap.challenge, bootstrap.expiresAt, bootstrap.origin];
  context.push(bootstrap.fieldKind);
  return new TextEncoder().encode(JSON.stringify(context));
}

export async function createDesktopTransaction(origin: string, now = Date.now(), fieldKind: FieldKind = "short-text"): Promise<DesktopTransaction> {
  const parsedOrigin = new URL(origin);
  const localDevelopment = parsedOrigin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname);
  if (parsedOrigin.origin !== origin || (parsedOrigin.protocol !== "https:" && !localDevelopment)) throw new Error("insecure destination origin");
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  const keys = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const readToken = randomToken(32);
  const writeToken = randomToken(32);
  const bootstrap: Bootstrap = {
    v: 5,
    // 32 random bytes encode to 43 unpadded base64url characters: exactly 256 bits.
    id: randomToken(32),
    publicKey: bytesToBase64Url(publicKey),
    challenge: randomToken(16),
    expiresAt: now + SESSION_TTL_MS,
    origin,
    writeToken,
    fieldKind
  };
  publicKey.fill(0);
  const [readTokenHash, writeTokenHash] = await Promise.all([hashToken(readToken), hashToken(writeToken)]);
  return { bootstrap, privateKey: keys.privateKey, readToken, readTokenHash, writeTokenHash };
}

export function bootstrapUrl(serviceOrigin: string, bootstrap: Bootstrap): string {
  if (bootstrap.slot !== "B" && bootstrap.slot !== "G") throw new Error("missing deployment slot");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(bootstrap.id)) throw new Error("invalid transaction route");
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(bootstrap)));
  return `${serviceOrigin}/t/${bootstrap.id}#${encoded}`;
}

export async function decryptEnvelope(transaction: DesktopTransaction, envelope: Envelope): Promise<Uint8Array> {
  if (envelope.v !== 5 || transaction.bootstrap.v !== 5 || !/^[A-Za-z0-9_-]{16}$/u.test(envelope.nonce)) {
    throw new Error("invalid envelope");
  }
  if (!/^[A-Za-z0-9_-]{87}$/u.test(envelope.phonePublicKey)) throw new Error("invalid envelope");
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  const phonePublicKey = await crypto.subtle.importKey("raw", arrayBuffer(base64UrlToBytes(envelope.phonePublicKey)), algorithm, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: algorithm.name, public: phonePublicKey }, transaction.privateKey, 256));
  const aad = aadFor(transaction.bootstrap);
  const salt = await crypto.subtle.digest("SHA-256", arrayBuffer(aad));
  const hkdfKey = await crypto.subtle.importKey("raw", arrayBuffer(shared), "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: arrayBuffer(INFO_V5) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const nonce = base64UrlToBytes(envelope.nonce);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  if (ciphertext.length > MAX_PLAINTEXT_BYTES + 16) throw new Error("payload too large");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(aad) }, encryptionKey, arrayBuffer(ciphertext)));
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
  }
}
