declare const __SERVICE_ORIGIN__: string;
export {};

import {
  deadlineSignal,
  MAX_RESERVATION_RESPONSE_BYTES,
  readBoundedJson,
  readBoundedSse
} from "./bounded-response.js";

const MENU_ID = "fill-from-phone";
const relayControllers = new Map<string, AbortController>();

interface RelayEnvelope {
  v: 5;
  phonePublicKey: string;
  nonce: string;
  ciphertext: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay message");
  return value as Record<string, unknown>;
}

function token(value: unknown, length: number): string {
  if (typeof value !== "string" || value.length !== length || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("invalid relay message");
  }
  return value;
}

function encoded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("invalid relay message");
  }
  return value;
}

function envelope(value: unknown): RelayEnvelope {
  const candidate = record(value);
  if (candidate.v !== 5) throw new Error("invalid relay envelope");
  return {
    v: candidate.v,
    phonePublicKey: token(candidate.phonePublicKey, 87),
    nonce: token(candidate.nonce, 16),
    ciphertext: encoded(candidate.ciphertext, 90_000)
  };
}

function slot(value: unknown): "B" | "G" {
  if (value !== "B" && value !== "G") throw new Error("invalid relay slot");
  return value;
}

function expiry(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= Date.now() || Number(value) > Date.now() + 120_000) {
    throw new Error("invalid relay expiry");
  }
  return Number(value);
}

async function reserveRelay(message: Record<string, unknown>): Promise<"B" | "G"> {
  const id = token(message.id, 43);
  const expiresAt = expiry(message.expiresAt);
  relayControllers.get(id)?.abort();
  const controller = new AbortController();
  relayControllers.set(id, controller);
  try {
    const body = JSON.stringify({
      id,
      expiresAt,
      writeTokenHash: token(message.writeTokenHash, 43),
      readTokenHash: token(message.readTokenHash, 43)
    });
    const response = await fetch(`${__SERVICE_ORIGIN__}/v1/session`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: deadlineSignal(controller, expiresAt),
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!response.ok) throw new Error("reserve failed");
    const result = record(await readBoundedJson(
      response,
      MAX_RESERVATION_RESPONSE_BYTES,
      controller,
      deadlineSignal(controller, expiresAt)
    ));
    const assignedSlot = slot(result.slot);
    if (result.status !== "reserved") throw new Error("invalid reserve response");
    return assignedSlot;
  } catch (error) {
    if (relayControllers.get(id) === controller) relayControllers.delete(id);
    throw error;
  }
}

async function waitForRelay(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<RelayEnvelope> {
  const id = token(message.id, 43);
  const assignedSlot = slot(message.slot);
  const readToken = token(message.readToken, 43);
  const expiresAt = expiry(message.expiresAt);
  const controller = relayControllers.get(id) ?? new AbortController();
  relayControllers.set(id, controller);
  try {
    const signal = deadlineSignal(controller, expiresAt);
    const response = await fetch(`${__SERVICE_ORIGIN__}/v1/${assignedSlot}/session/${id}/events`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
      headers: { "X-Read-Token": readToken }
    });
    if (!response.ok || !response.body) throw new Error("relay unavailable");
    return await readBoundedSse(response, controller, signal, (event) => {
      const lines = event.replaceAll("\r\n", "\n").split("\n");
      const eventNames = lines.filter((line) => line.startsWith("event:")).map((line) => line.slice(6).trimStart());
      if (eventNames.length > 1) throw new Error("invalid event");
      const eventName = eventNames[0];
      if (eventName === undefined) return undefined;
      if (eventName === "expired") throw new Error("expired");
      if (eventName === "claimed") {
        if (sender.tab?.id !== undefined) {
          void chrome.tabs.sendMessage(
            sender.tab.id,
            { type: "FFP_RELAY_CLAIMED", id },
            { frameId: sender.frameId ?? 0 }
          ).catch(() => undefined);
        }
        return undefined;
      }
      if (eventName !== "payload") return undefined;
      const dataLines = lines.filter((line) => line.startsWith("data:"));
      if (dataLines.length !== 1) throw new Error("invalid event");
      const data = dataLines[0]!.slice(5).trimStart();
      if (!data) throw new Error("invalid event");
      return envelope(JSON.parse(data));
    });
  } finally {
    if (relayControllers.get(id) === controller) relayControllers.delete(id);
  }
}

async function cancelRelay(message: Record<string, unknown>): Promise<void> {
  const id = token(message.id, 43);
  relayControllers.get(id)?.abort();
  relayControllers.delete(id);
  if (message.slot === undefined) return;
  const assignedSlot = slot(message.slot);
  const readToken = token(message.readToken, 43);
  const controller = new AbortController();
  const response = await fetch(`${__SERVICE_ORIGIN__}/v1/${assignedSlot}/session/${id}`, {
    method: "DELETE",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    headers: { "X-Read-Token": readToken }
  });
  if (!response.ok) throw new Error("cancel failed");
}

async function handleRelayMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  if (message.type === "FFP_RELAY_RESERVE") {
    return { ok: true, slot: await reserveRelay(message) };
  }
  if (message.type === "FFP_RELAY_WAIT") {
    return { ok: true, envelope: await waitForRelay(message, sender) };
  }
  if (message.type === "FFP_RELAY_CANCEL") {
    await cancelRelay(message);
    return { ok: true };
  }
  throw new Error("unknown relay message");
}

function installMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Fill from Phone",
      contexts: ["editable"]
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  installMenu();
  if (details.reason === "install") {
    void chrome.tabs.create({ url: `${__SERVICE_ORIGIN__}/test` });
  }
});
chrome.runtime.onStartup.addListener(installMenu);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  let candidate: Record<string, unknown>;
  try {
    candidate = record(message);
  } catch {
    return;
  }
  if (candidate.type === "FFP_RELAY_KEEPALIVE") {
    try {
      sendResponse({ ok: relayControllers.has(token(candidate.id, 43)) });
    } catch {
      sendResponse({ ok: false });
    }
    return;
  }
  if (!["FFP_RELAY_RESERVE", "FFP_RELAY_WAIT", "FFP_RELAY_CANCEL"].includes(String(candidate.type))) return;
  void (async () => {
    try {
      sendResponse(await handleRelayMessage(candidate, sender));
    } catch {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.editable || tab?.id === undefined) return;
  const frameId = info.frameId ?? 0;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "FILL_FROM_PHONE_START" }, { frameId });
  } catch {
    // Restricted Chrome pages and disappearing frames fail closed without exposing data.
  }
});
