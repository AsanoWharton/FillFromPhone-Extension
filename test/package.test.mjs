import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { unzipSync } from "fflate";

test("packaged extension contains only the reviewed runtime files", async () => {
  const archive = new Uint8Array(await readFile(new URL("../release/remote-fill-extension.zip", import.meta.url)));
  const unpacked = unzipSync(archive);
  const entries = Object.keys(unpacked).sort();
  assert.deepEqual(entries, ["LICENSE-dijkstrajs.txt", "LICENSE-font-awesome.txt", "LICENSE-public-sans.txt", "LICENSE-qrcode.txt", "PROPRIETARY-NOTICE.txt", "background.js", "content.js", "icon-128.png", "icon-16.png", "icon-32.png", "icon-48.png", "manifest.json", "popup.css", "popup.html", "popup.js", "presence.js", "public-sans-400.woff2", "public-sans-700.woff2"]);
  assert.match(new TextDecoder().decode(unpacked["PROPRIETARY-NOTICE.txt"]), /proprietary\. All rights are\s+reserved/u);
  assert.match(new TextDecoder().decode(unpacked["LICENSE-font-awesome.txt"]), /Creative Commons\s+Attribution 4\.0/u);
});

test("manifest retains the minimum permission set", async () => {
  const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "contextMenus", "scripting"]);
  assert.equal(manifest.version, "0.7.0");
  assert.deepEqual(manifest.host_permissions, ["https://remotefill.com/*"]);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.icons, { "16": "icon-16.png", "32": "icon-32.png", "48": "icon-48.png", "128": "icon-128.png" });
  assert.deepEqual(manifest.action.default_icon, { "16": "icon-16.png", "32": "icon-32.png" });
  assert.deepEqual(manifest.content_scripts, [{ matches: ["https://remotefill.com/test"], js: ["presence.js"], run_at: "document_start" }]);
  assert.equal(manifest.externally_connectable, undefined);
});

test("extension icon has the required dimensions and transparent padding", async () => {
  const icon = await readFile(new URL("../dist/icon-128.png", import.meta.url));
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
  assert.equal(icon[25], 6);
});

test("versioned and generic release archives are byte-identical", async () => {
  const genericArchive = await readFile(new URL("../release/remote-fill-extension.zip", import.meta.url));
  const versionedArchive = await readFile(new URL("../release/remote-fill-0.7.0-chrome-web-store.zip", import.meta.url));
  assert.ok(genericArchive.byteLength > 0);
  assert.deepEqual(versionedArchive, genericArchive);
});

test("first install opens the same-origin test page", async () => {
  const background = await readFile(new URL("../dist/background.js", import.meta.url), "utf8");
  const presence = await readFile(new URL("../dist/presence.js", import.meta.url), "utf8");
  assert.equal(background.includes("https://remotefill.com/test"), true);
  assert.match(background, /reason===?"install"/u);
  assert.match(presence, /data-fill-from-phone-extension/u);
  assert.doesNotMatch(presence, /fetch\(|XMLHttpRequest|chrome\.runtime|chrome\.tabs|chrome\.scripting|localStorage|sessionStorage|indexedDB/u);
});

test("only the extension service worker performs relay networking", async () => {
  const background = await readFile(new URL("../dist/background.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../dist/content.js", import.meta.url), "utf8");
  const backgroundSource = await readFile(new URL("../src/background.ts", import.meta.url), "utf8");
  assert.match(background, /\/v1\/session/u);
  assert.match(content, /FFP_RELAY_RESERVE/u);
  assert.doesNotMatch(content, /\/v1\/session/u);
  assert.doesNotMatch(`${background}\n${content}`, /X25519/u);
  assert.match(content, /Short text field/u);
  assert.match(content, /Long text field/u);
  assert.match(content, /Password field/u);
  assert.match(content, /Remote Fill/u);
  assert.doesNotMatch(content, /Secure device handoff|class="key"/u);
  assert.equal((backgroundSource.match(/token\((?:message|candidate)\.id, 43\)/gu) ?? []).length, 4);
  assert.doesNotMatch(backgroundSource, /token\((?:message|candidate)\.id, 46\)/u);
  assert.doesNotMatch(backgroundSource, /\.then\(/u);
});

test("terminal transfer state, exact target binding, and transport budgets guard the plaintext sink", async () => {
  const [backgroundSource, contentSource, popupSource, boundedSource, bindingSource] = await Promise.all([
    readFile(new URL("../src/background.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/content.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/popup.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/bounded-response.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/target-binding.ts", import.meta.url), "utf8")
  ]);
  const decryptIndex = contentSource.indexOf("const plaintext = await decryptEnvelope");
  const releaseIndex = contentSource.indexOf("releasePlaintext(", decryptIndex);
  const contextIndex = contentSource.indexOf("assertTransferContext(active!)", releaseIndex);
  const injectIndex = contentSource.indexOf("injectBoundValue(binding, plaintext", contextIndex);
  assert.ok(decryptIndex >= 0 && releaseIndex > decryptIndex && contextIndex > releaseIndex && injectIndex > contextIndex);
  const dispatchIndex = bindingSource.indexOf("target.dispatchEvent(before)");
  const revalidateIndex = bindingSource.indexOf("revalidate();", dispatchIndex);
  const writeIndex = bindingSource.indexOf("HTMLInputElement.prototype", revalidateIndex);
  assert.ok(dispatchIndex >= 0 && revalidateIndex > dispatchIndex && writeIndex > revalidateIndex);
  const failureIndex = contentSource.indexOf("} catch {", injectIndex);
  const cancelIndex = contentSource.indexOf("if (active) await cancel(active)", failureIndex);
  const cleanupIndex = contentSource.indexOf("clearRuntimeIfOwned(lifecycle)", cancelIndex);
  assert.ok(failureIndex > injectIndex && cancelIndex > failureIndex && cleanupIndex > cancelIndex);
  const claimedIndex = contentSource.indexOf("runtime.__fillFromPhoneClaimed = (id) => {");
  const claimedCancelIndex = contentSource.indexOf("void cancel(active)", claimedIndex);
  const claimedHandlerEndIndex = contentSource.indexOf("    };", claimedIndex);
  assert.ok(claimedIndex >= 0 && claimedCancelIndex > claimedIndex && claimedCancelIndex < claimedHandlerEndIndex);
  assert.match(contentSource, /expiresAt: transaction\.bootstrap\.expiresAt/u);
  assert.match(backgroundSource, /readBoundedJson\(/u);
  assert.match(backgroundSource, /readBoundedSse\(/u);
  assert.ok(
    backgroundSource.indexOf("relayControllers.get(id)?.abort()", backgroundSource.indexOf("async function cancelRelay")) <
    backgroundSource.indexOf("if (message.slot === undefined) return", backgroundSource.indexOf("async function cancelRelay"))
  );
  assert.doesNotMatch(`${backgroundSource}\n${popupSource}\n${boundedSource}`, /AbortSignal\.(?:any|timeout)/u);
});
