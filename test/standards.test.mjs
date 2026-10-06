import assert from "node:assert/strict";
import test from "node:test";

const hex = (value) => Uint8Array.from(Buffer.from(value, "hex"));
const hexString = (value) => Buffer.from(value).toString("hex");

test("SHA-256 matches the FIPS 180-4 abc known answer", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
  assert.equal(hexString(digest), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("HKDF-SHA-256 matches RFC 5869 test case 1", async () => {
  const material = await crypto.subtle.importKey("raw", hex("0b".repeat(22)), "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: hex("000102030405060708090a0b0c"),
    info: hex("f0f1f2f3f4f5f6f7f8f9")
  }, material, 42 * 8);
  assert.equal(hexString(derived), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
});

test("AES-256-GCM matches the zero-length 96-bit-IV known answer", async () => {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 128 }, key, new Uint8Array());
  assert.equal(hexString(encrypted), "530f8afbc74536b9a963b4f1c4cb738b");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 128 }, key, encrypted);
  assert.equal(plaintext.byteLength, 0);
});

test("independent P-256 endpoints derive the same 256-bit secret", async () => {
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  const first = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]);
  const second = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]);
  const firstSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: second.publicKey }, first.privateKey, 256);
  const secondSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: first.publicKey }, second.privateKey, 256);
  assert.equal(first.privateKey.extractable, false);
  assert.equal(second.privateKey.extractable, false);
  assert.deepEqual(new Uint8Array(firstSecret), new Uint8Array(secondSecret));
});
