import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("page-controlled beforeinput cannot redirect the bound plaintext sink", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "fillfromphone-target-binding-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "target-binding.js");
  await build({
    entryPoints: [new URL("../src/target-binding.ts", import.meta.url).pathname],
    outfile: bundle,
    bundle: true,
    format: "iife",
    globalName: "FFPTargetBinding",
    target: "chrome120",
    legalComments: "none"
  });

  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><form id="original"><div id="field-context"><input id="chosen" name="username" type="text" autocomplete="username"></div><input id="other" type="text"></form><div id="elsewhere"></div>`);
  await page.addScriptTag({ path: bundle });

  const result = await page.evaluate(() => {
    const api = globalThis.FFPTargetBinding;
    const chosen = document.querySelector("#chosen");
    const other = document.querySelector("#other");
    const elsewhere = document.querySelector("#elsewhere");
    const bytes = (value) => new TextEncoder().encode(value);
    const attempt = (mutation) => {
      chosen.value = "";
      chosen.name = "username";
      document.querySelector("#field-context").append(chosen);
      document.querySelector("#original").prepend(document.querySelector("#field-context"));
      chosen.focus();
      const binding = api.bindFieldTarget(chosen);
      chosen.addEventListener("beforeinput", mutation, { once: true });
      let rejected = false;
      try {
        api.injectBoundValue(binding, bytes("synthetic-secret"), () => api.assertFieldTargetBinding(binding));
      } catch {
        rejected = true;
      }
      return { rejected, chosen: chosen.value, other: other.value };
    };

    chosen.focus();
    const legitimate = api.bindFieldTarget(chosen);
    api.injectBoundValue(legitimate, bytes("ordinary-value"), () => api.assertFieldTargetBinding(legitimate));
    const ordinary = chosen.value;

    const reparented = attempt(() => { elsewhere.append(chosen); });
    const ancestorMoved = attempt(() => { elsewhere.append(document.querySelector("#field-context")); });
    const refocused = attempt(() => { other.focus(); });
    const reclassified = attempt(() => { chosen.name = "attacker-selected"; });
    const cancelled = attempt((event) => { event.preventDefault(); });
    return { ordinary, reparented, ancestorMoved, refocused, reclassified, cancelled };
  });

  assert.equal(result.ordinary, "ordinary-value");
  for (const attack of [result.reparented, result.ancestorMoved, result.refocused, result.reclassified, result.cancelled]) {
    assert.equal(attack.rejected, true);
    assert.equal(attack.chosen, "");
    assert.equal(attack.other, "");
  }
});
