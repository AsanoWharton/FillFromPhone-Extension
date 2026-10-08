import assert from "node:assert/strict";
import test from "node:test";
import {
  armDeadline,
  readBoundedJson,
  readBoundedSse
} from "../src/bounded-response.ts";

function chunked(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  }));
}

test("chunked reservation JSON is rejected before unbounded parsing", async () => {
  const controller = new AbortController();
  const response = chunked(["{\"status\":\"", "x".repeat(64), "\"}"]);
  await assert.rejects(() => readBoundedJson(response, 32, controller, controller.signal), /too large/u);
  assert.equal(controller.signal.aborted, true);
});

test("reservation limits charge UTF-8 bytes rather than code units", async () => {
  const controller = new AbortController();
  const response = chunked([JSON.stringify({ value: "😀" })]);
  await assert.rejects(() => readBoundedJson(response, 13, controller, controller.signal), /too large/u);
});

test("an unterminated SSE event cannot exceed the pending-event budget", async () => {
  const controller = new AbortController();
  const response = chunked(["event: payload\ndata: ", "x".repeat(40)]);
  await assert.rejects(() => readBoundedSse(
    response,
    controller,
    controller.signal,
    () => undefined,
    { maxEventBytes: 32, maxResponseBytes: 128, maxEvents: 8 }
  ), /event too large/u);
  assert.equal(controller.signal.aborted, true);
});

test("every SSE event counts toward the event budget", async () => {
  const controller = new AbortController();
  const response = chunked([": one\n\n", "event: unknown\n\n", "event: claimed\n\n"]);
  await assert.rejects(() => readBoundedSse(
    response,
    controller,
    controller.signal,
    () => undefined,
    { maxEventBytes: 64, maxResponseBytes: 256, maxEvents: 2 }
  ), /too many events/u);
});

test("a fixed deadline aborts a slow stream", async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start() {} }));
  const clearDeadline = armDeadline(controller, Date.now() + 20);
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(() => readBoundedSse(response, controller, controller.signal, () => undefined));
    assert.equal(controller.signal.aborted, true);
  } finally {
    clearDeadline();
    clearTimeout(keepAlive);
  }
});

test("a cleared deadline does not abort a completed operation", async () => {
  const controller = new AbortController();
  const clearDeadline = armDeadline(controller, Date.now() + 10);
  clearDeadline();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.signal.aborted, false);
});

test("legitimate claimed and payload events survive arbitrary chunk boundaries", async () => {
  const controller = new AbortController();
  const response = chunked([": con", "nected\n\nevent: claimed\r\n", "data: {}\r\n\r\nevent: payload\n", "data: {\"ok\":true}\n\n"]);
  const names = [];
  const result = await readBoundedSse(response, controller, controller.signal, (event) => {
    const name = event.replaceAll("\r\n", "\n").split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (name) names.push(name);
    if (name === "payload") return JSON.parse(event.split("data: ")[1]);
    return undefined;
  });
  assert.deepEqual(names, ["claimed", "payload"]);
  assert.deepEqual(result, { ok: true });
});

test("the maximum protocol payload fits inside the transport budget", async () => {
  const controller = new AbortController();
  const ciphertext = "A".repeat(90_000);
  const event = `event: payload\ndata: ${JSON.stringify({
    v: 5,
    phonePublicKey: "A".repeat(87),
    nonce: "A".repeat(16),
    ciphertext
  })}\n\n`;
  const response = chunked([event.slice(0, 101), event.slice(101, 32_000), event.slice(32_000)]);
  const result = await readBoundedSse(response, controller, controller.signal, (block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? JSON.parse(data) : undefined;
  });
  assert.equal(result.ciphertext.length, 90_000);
});
