export const MAX_RESERVATION_RESPONSE_BYTES = 4 * 1024;
export const MAX_SSE_EVENT_BYTES = 96 * 1024;
export const MAX_SSE_RESPONSE_BYTES = 256 * 1024;
export const MAX_SSE_EVENTS = 64;

interface SseLimits {
  maxEventBytes: number;
  maxResponseBytes: number;
  maxEvents: number;
}

const DEFAULT_SSE_LIMITS: SseLimits = {
  maxEventBytes: MAX_SSE_EVENT_BYTES,
  maxResponseBytes: MAX_SSE_RESPONSE_BYTES,
  maxEvents: MAX_SSE_EVENTS
};

function declaredLength(response: Response): number | undefined {
  const header = response.headers.get("Content-Length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(header)) throw new Error("invalid response length");
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new Error("invalid response length");
  return length;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  return await new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function responseReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!response.body) throw new Error("response body missing");
  return response.body.getReader();
}

export function armDeadline(
  controller: AbortController,
  expiresAt: number,
  maximumLifetimeMs = Number.POSITIVE_INFINITY,
  now = Date.now()
): () => void {
  if (controller.signal.aborted) throw controller.signal.reason;
  const remaining = Math.min(expiresAt - now, maximumLifetimeMs);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    controller.abort(new DOMException("Relay deadline elapsed", "TimeoutError"));
    throw controller.signal.reason;
  }
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException("Relay deadline elapsed", "TimeoutError"));
  }, Math.ceil(remaining));
  const clear = (): void => globalThis.clearTimeout(timer);
  controller.signal.addEventListener("abort", clear, { once: true });
  return () => {
    clear();
    controller.signal.removeEventListener("abort", clear);
  };
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
  signal: AbortSignal
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const length = declaredLength(response);
    if (length !== undefined && length > maximumBytes) throw new Error("response too large");
    reader = responseReader(response);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await readWithSignal(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("response too large");
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
  }
}

export async function readBoundedSse<T>(
  response: Response,
  controller: AbortController,
  signal: AbortSignal,
  onEvent: (event: string) => T | undefined,
  limits: SseLimits = DEFAULT_SSE_LIMITS
): Promise<T> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const length = declaredLength(response);
    if (length !== undefined && length > limits.maxResponseBytes) throw new Error("response too large");
    reader = responseReader(response);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const pending = new Uint8Array(limits.maxEventBytes + 4);
    let pendingLength = 0;
    let total = 0;
    let events = 0;
    while (true) {
      const { value, done } = await readWithSignal(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limits.maxResponseBytes) throw new Error("response too large");
      for (const byte of value) {
        if (pendingLength >= pending.byteLength) throw new Error("event too large");
        pending[pendingLength] = byte;
        pendingLength += 1;
        const lfBoundary = pendingLength >= 2 && pending[pendingLength - 2] === 10 && pending[pendingLength - 1] === 10;
        const crlfBoundary = pendingLength >= 4 && pending[pendingLength - 4] === 13 && pending[pendingLength - 3] === 10 &&
          pending[pendingLength - 2] === 13 && pending[pendingLength - 1] === 10;
        if (!lfBoundary && !crlfBoundary) continue;
        const boundaryLength = crlfBoundary ? 4 : 2;
        const eventLength = pendingLength - boundaryLength;
        if (eventLength > limits.maxEventBytes) throw new Error("event too large");
        events += 1;
        if (events > limits.maxEvents) throw new Error("too many events");
        const result = onEvent(decoder.decode(pending.subarray(0, eventLength)));
        pendingLength = 0;
        if (result !== undefined) return result;
      }
      if (pendingLength > limits.maxEventBytes + 3) throw new Error("event too large");
    }
    throw new Error("stream ended");
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
  }
}
