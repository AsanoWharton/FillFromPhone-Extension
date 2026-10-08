export type TransferState = "active" | "cancelled" | "consumed";

export interface TransferLifecycle {
  readonly token: object;
  readonly controller: AbortController;
  state: TransferState;
}

export function createTransferLifecycle(token: object, controller = new AbortController()): TransferLifecycle {
  return { token, controller, state: "active" };
}

export function cancelTransfer(lifecycle: TransferLifecycle): void {
  if (lifecycle.state === "active") lifecycle.state = "cancelled";
  lifecycle.controller.abort();
}

export function assertTransferActive(
  lifecycle: TransferLifecycle,
  currentToken: object | undefined,
  expiresAt: number,
  now = Date.now()
): void {
  if (
    lifecycle.state !== "active" || lifecycle.controller.signal.aborted ||
    lifecycle.token !== currentToken || now >= expiresAt
  ) {
    throw new Error("transfer is no longer active");
  }
}

export function releasePlaintext(
  lifecycle: TransferLifecycle,
  currentToken: object | undefined,
  expiresAt: number,
  plaintext: Uint8Array,
  release: () => void,
  now = Date.now()
): void {
  try {
    assertTransferActive(lifecycle, currentToken, expiresAt, now);
    release();
    lifecycle.state = "consumed";
  } finally {
    plaintext.fill(0);
  }
}
