declare const __SERVICE_ORIGIN__: string;

async function checkRelay(): Promise<void> {
  const dot = document.querySelector<HTMLElement>("#status-dot")!;
  const copy = document.querySelector<HTMLElement>("#status-copy")!;
  try {
    const response = await fetch(`${__SERVICE_ORIGIN__}/api/health/ready`, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(4_000)
    });
    if (!response.ok) throw new Error("relay unavailable");
    dot.classList.add("ready");
    copy.textContent = "Relay available";
  } catch {
    dot.classList.add("unavailable");
    copy.textContent = "Relay unavailable — try again shortly";
  }
}

void checkRelay();

