import QRCode from "qrcode";
import { bootstrapUrl, createDesktopTransaction, decryptEnvelope, type DesktopTransaction, type Envelope, type FieldKind } from "./protocol.js";

declare const __SERVICE_ORIGIN__: string;

interface ActiveTransfer {
  controller: AbortController;
  transaction: DesktopTransaction;
  target: HTMLElement;
  documentRef: Document;
  origin: string;
  overlay: HTMLElement;
}

interface RelayResponse {
  ok?: boolean;
  slot?: "B" | "G";
  envelope?: Envelope;
}

const runtime = globalThis as typeof globalThis & {
  __fillFromPhoneInstalled?: boolean;
  __fillFromPhoneCancel?: () => void;
  __fillFromPhoneClaimed?: (id: string) => void;
};

function deepestActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function isEditable(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return ["text", "email", "password", "search", "tel", "url"].includes(element.type) && !element.disabled && !element.readOnly;
  }
  return element.isContentEditable;
}

function fieldKindFor(element: HTMLElement): FieldKind {
  if (element instanceof HTMLInputElement) return element.type === "password" ? "password" : "short-text";
  return "long-text";
}

function showNotice(message: string): void {
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;left:50%;bottom:1.25rem;z-index:2147483647;transform:translateX(-50%);";
  const shadow = host.attachShadow({ mode: "closed" });
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.style.cssText = "max-width:min(24rem,calc(100vw - 2rem));padding:.75rem 1rem;border:1px solid #cbc8bf;border-left:.35rem solid #146c68;border-radius:.35rem;background:#fff;color:#222522;box-shadow:0 .35rem 1.25rem rgb(0 0 0 / .2);font:14px/1.45 system-ui,-apple-system,sans-serif;text-align:left;";
  notice.textContent = message;
  shadow.append(notice);
  document.documentElement.append(host);
  window.setTimeout(() => host.remove(), 4_000);
}

function overlayElement(fieldKind: FieldKind, destination: string): { host: HTMLElement; canvas: HTMLCanvasElement; status: HTMLElement; timer: HTMLElement; cancel: HTMLButtonElement } {
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgb(0 0 0 / .42);";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}.panel{width:min(23rem,calc(100vw - 2rem));padding:0 1.35rem 1.35rem;border:1px solid #cbc8bf;border-top:.45rem solid #146c68;border-radius:.6rem;background:#fff;color:#222522;box-shadow:0 1rem 4rem rgb(0 0 0 / .28);font:14px/1.45 system-ui,-apple-system,sans-serif;text-align:center}.titlebar{display:flex;align-items:center;justify-content:center;margin:0 -1.35rem 1rem;padding:.85rem 1.35rem;background:#deeeea;color:#0d514e}.titlebar h2{margin:0;font:800 19px/1.2 system-ui,-apple-system,sans-serif}.classification{display:inline-block;margin:0 0 .35rem;padding:.2rem .5rem;border-radius:.2rem;background:#deeeea;color:#0d514e;font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.destination{margin:.1rem 0 .75rem;color:#5c635e;font-weight:650;overflow-wrap:anywhere}canvas{display:block;width:min(320px,100%);height:auto;margin:.5rem auto;padding:.35rem;border:1px solid #cbc8bf;border-radius:.55rem;background:#fff}.status{margin:.75rem 0 .2rem;font-weight:800;color:#0d514e}.timer{margin:.2rem 0;color:#5c635e;font-variant-numeric:tabular-nums}button{margin-top:.75rem;border:2px solid #146c68;border-radius:.35rem;padding:.55rem .9rem;background:#fff;color:#0d514e;font:700 14px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer}button:hover{background:#deeeea}button:focus{outline:4px solid #f2b84b;outline-offset:2px}
  </style><section class="panel" role="dialog" aria-modal="true" aria-labelledby="ffp-title"><div class="titlebar"><h2 id="ffp-title">Fill from Phone</h2></div><p class="classification"></p><p class="destination"></p><canvas width="320" height="320" aria-label="One-time transfer QR code"></canvas><p class="status">Preparing one-time code…</p><p class="timer"></p><button type="button">Cancel</button></section>`;
  shadow.querySelector<HTMLElement>(".classification")!.textContent = fieldKind === "password" ? "Password field" : fieldKind === "long-text" ? "Long text field" : "Short text field";
  shadow.querySelector<HTMLElement>(".destination")!.textContent = `Destination: ${destination}`;
  return {
    host,
    canvas: shadow.querySelector("canvas")!,
    status: shadow.querySelector<HTMLElement>(".status")!,
    timer: shadow.querySelector<HTMLElement>(".timer")!,
    cancel: shadow.querySelector<HTMLButtonElement>("button")!
  };
}

async function relayMessage(message: Record<string, unknown>): Promise<RelayResponse> {
  const response = await chrome.runtime.sendMessage(message) as RelayResponse | undefined;
  if (!response?.ok) throw new Error("relay operation failed");
  return response;
}

async function reserve(transaction: DesktopTransaction): Promise<void> {
  const response = await relayMessage({
    type: "FFP_RELAY_RESERVE",
    id: transaction.bootstrap.id,
    expiresAt: transaction.bootstrap.expiresAt,
    writeTokenHash: transaction.writeTokenHash,
    readTokenHash: transaction.readTokenHash
  });
  if (response.slot !== "B" && response.slot !== "G") {
    throw new Error("relay returned no slot-bound session ID");
  }
  transaction.bootstrap.slot = response.slot;
}

async function waitForEnvelope(transaction: DesktopTransaction): Promise<Envelope> {
  const keepalive = window.setInterval(() => {
    void chrome.runtime.sendMessage({ type: "FFP_RELAY_KEEPALIVE", id: transaction.bootstrap.id }).catch(() => undefined);
  }, 15_000);
  try {
    const response = await relayMessage({
      type: "FFP_RELAY_WAIT",
      id: transaction.bootstrap.id,
      slot: transaction.bootstrap.slot,
      readToken: transaction.readToken
    });
    if (!response.envelope) throw new Error("relay returned no envelope");
    return response.envelope;
  } finally {
    window.clearInterval(keepalive);
  }
}

function inject(target: HTMLElement, plaintext: Uint8Array): void {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: value });
  if (!target.dispatchEvent(before)) throw new Error("insertion refused");
  if (target instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
  } else if (target instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);
  } else {
    target.textContent = value;
  }
  target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

async function cancel(active: ActiveTransfer): Promise<void> {
  active.controller.abort();
  active.overlay.remove();
  delete runtime.__fillFromPhoneClaimed;
  try {
    await relayMessage({
      type: "FFP_RELAY_CANCEL",
      id: active.transaction.bootstrap.id,
      slot: active.transaction.bootstrap.slot,
      readToken: active.transaction.readToken
    });
  } catch {
    // Expiry remains the backstop when cancellation cannot reach the relay.
  }
}

async function startTransfer(): Promise<void> {
  runtime.__fillFromPhoneCancel?.();
  const target = deepestActiveElement();
  if (!isEditable(target)) {
    showNotice("Focus a supported text field, then try Fill from Phone again.");
    return;
  }
  const origin = location.origin;
  const localDevelopment = location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol !== "https:" && !localDevelopment) {
    showNotice("Fill from Phone requires a secure HTTPS page.");
    return;
  }
  const fieldKind = fieldKindFor(target);
  const documentRef = document;
  const ui = overlayElement(fieldKind, location.host);
  document.documentElement.append(ui.host);
  const controller = new AbortController();
  let active: ActiveTransfer | undefined;
  let timer: number | undefined;

  try {
    const transaction = await createDesktopTransaction(origin, Date.now(), fieldKind);
    active = { controller, transaction, target, documentRef, origin, overlay: ui.host };
    runtime.__fillFromPhoneCancel = () => { if (active) void cancel(active); };
    runtime.__fillFromPhoneClaimed = (id) => {
      if (!active || active.transaction.bootstrap.id !== id) return;
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      ui.canvas.remove();
      ui.status.textContent = "Phone connected";
      ui.timer.textContent = "This QR code cannot be claimed again.";
    };
    ui.cancel.addEventListener("click", () => { if (active) void cancel(active); }, { once: true });
    await reserve(transaction);
    await QRCode.toCanvas(ui.canvas, bootstrapUrl(__SERVICE_ORIGIN__, transaction.bootstrap), { width: 320, margin: 4, errorCorrectionLevel: "M", color: { dark: "#0d514e", light: "#ffffff" } });
    ui.status.textContent = "Scan to continue on your phone";
    const updateTimer = (): void => {
      const seconds = Math.max(0, Math.ceil((transaction.bootstrap.expiresAt - Date.now()) / 1_000));
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      ui.timer.textContent = `Expires ${minutes}:${remainder.toString().padStart(2, "0")}`;
    };
    updateTimer();
    timer = window.setInterval(updateTimer, 250);
    const envelope = await waitForEnvelope(transaction);
    if (timer !== undefined) window.clearInterval(timer);
    if (
      Date.now() >= transaction.bootstrap.expiresAt || document !== documentRef ||
      location.origin !== origin || !target.isConnected || !isEditable(target) || fieldKindFor(target) !== fieldKind
    ) throw new Error("target context changed");
    const plaintext = await decryptEnvelope(transaction, envelope);
    try {
      inject(target, plaintext);
    } finally {
      plaintext.fill(0);
    }
    ui.status.textContent = "Filled";
    ui.timer.textContent = "Review the field before submitting.";
    window.setTimeout(() => ui.host.remove(), 1_500);
    active = undefined;
    delete runtime.__fillFromPhoneCancel;
    delete runtime.__fillFromPhoneClaimed;
  } catch {
    if (!controller.signal.aborted) {
      ui.status.textContent = "Transfer stopped";
      ui.timer.textContent = "Start a new transfer and try again.";
      window.setTimeout(() => ui.host.remove(), 2_500);
    }
  } finally {
    if (timer !== undefined) window.clearInterval(timer);
  }
}

if (!runtime.__fillFromPhoneInstalled) {
  runtime.__fillFromPhoneInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const candidate = message as { type?: string; id?: string };
    if (candidate?.type === "FILL_FROM_PHONE_START") void startTransfer();
    if (candidate?.type === "FFP_RELAY_CLAIMED" && typeof candidate.id === "string") runtime.__fillFromPhoneClaimed?.(candidate.id);
  });
}
