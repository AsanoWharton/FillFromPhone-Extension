/**
 * The installation test page may display a convenience-only presence state.
 * This marker carries no identifier or authority and must never gate security.
 */
function announcePresence(): void {
  const root = document.documentElement;
  if (!root) {
    window.requestAnimationFrame(announcePresence);
    return;
  }
  root.setAttribute("data-fill-from-phone-extension", "installed");
  document.dispatchEvent(new Event("fill-from-phone-extension-present"));
}

announcePresence();
