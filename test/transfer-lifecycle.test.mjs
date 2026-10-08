import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTransferActive,
  cancelTransfer,
  createTransferLifecycle,
  releasePlaintext
} from "../src/transfer-lifecycle.ts";

test("cancellation after decryption prevents release and clears plaintext", () => {
  const token = {};
  const lifecycle = createTransferLifecycle(token);
  const plaintext = Uint8Array.of(1, 2, 3);
  let released = false;
  cancelTransfer(lifecycle);
  assert.throws(() => releasePlaintext(lifecycle, token, 2_000, plaintext, () => { released = true; }, 1_000));
  assert.equal(released, false);
  assert.deepEqual(plaintext, new Uint8Array(3));
});

test("a superseded transfer cannot release or clear the new transfer state", () => {
  const oldToken = {};
  const currentToken = {};
  const lifecycle = createTransferLifecycle(oldToken);
  const plaintext = Uint8Array.of(9);
  assert.throws(() => releasePlaintext(lifecycle, currentToken, 2_000, plaintext, () => undefined, 1_000));
  assert.equal(lifecycle.state, "active");
  assert.deepEqual(plaintext, new Uint8Array(1));
});

test("expiry is terminal at the exact deadline", () => {
  const token = {};
  const lifecycle = createTransferLifecycle(token);
  assert.throws(() => assertTransferActive(lifecycle, token, 1_000, 1_000));
});

test("an active transfer releases exactly once and clears plaintext", () => {
  const token = {};
  const lifecycle = createTransferLifecycle(token);
  const plaintext = Uint8Array.of(4, 5, 6);
  let releases = 0;
  releasePlaintext(lifecycle, token, 2_000, plaintext, () => { releases += 1; }, 1_000);
  assert.equal(releases, 1);
  assert.equal(lifecycle.state, "consumed");
  assert.deepEqual(plaintext, new Uint8Array(3));
  assert.throws(() => releasePlaintext(lifecycle, token, 2_000, Uint8Array.of(7), () => { releases += 1; }, 1_000));
  assert.equal(releases, 1);
});
