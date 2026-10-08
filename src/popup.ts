import { armDeadline } from "./bounded-response.js";

declare const __SERVICE_ORIGIN__: string;

async function checkRelay(): Promise<void> {
  const dot = document.querySelector<HTMLElement>("#status-dot")!;
  const copy = document.querySelector<HTMLElement>("#status-copy")!;
  const controller = new AbortController();
  const clearDeadline = armDeadline(controller, Date.now() + 4_000);
  try {
    const response = await fetch(`${__SERVICE_ORIGIN__}/api/health/ready`, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("relay unavailable");
    dot.classList.add("ready");
    copy.textContent = "Relay available";
  } catch {
    dot.classList.add("unavailable");
    copy.textContent = "Relay unavailable — try again shortly";
  } finally {
    clearDeadline();
  }
}

void checkRelay();
