import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectCdp, findChromeExecutable } from "./fixtures/cdp-client.mjs";
import { startWebuiDemoServer } from "./fixtures/webui-demo-server.js";

// Browser e2e for the operator surface: real Chromium over raw CDP, driving
// the real bundle served by the real web server with a scripted fake agent.
// This is the "don't break the UI" net — the SSR markup pins in
// webapp-surface.test.ts check that markup renders; this file checks that the
// app actually boots, streams, and stays console-clean in a browser.
// Skips honestly when no Chrome is available (CI without a browser).

const chrome = findChromeExecutable();

/** Spawns headless Chrome with a CDP port and returns the browser ws URL. */
async function launchChrome(): Promise<{ child: ChildProcess; wsUrl: string; dataDir: string }> {
  if (chrome === null) throw new Error("launchChrome called without a Chrome executable");
  const dataDir = mkdtempSync(join(tmpdir(), "workflow-chrome-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=0`,
    `--user-data-dir=${dataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    child.on("exit", () => reject(new Error("chrome exited before DevTools endpoint was ready")));
    setTimeout(() => reject(new Error(`chrome DevTools endpoint not found, stderr:\n${buffer}`)), 15_000);
  });
  return { child, wsUrl, dataDir };
}

test("operator UI boots, streams a turn, and stays console-clean in real Chromium", async (t) => {
  if (chrome === null) {
    t.skip("no Chrome/Chromium executable found (set WORKFLOW_CHROME to enable)");
    return;
  }
  const demo = await startWebuiDemoServer();
  const browser = await launchChrome();
  try {
    const cdp = await connectCdp(browser.wsUrl, demo.url);

    // 1. The app boots: header wordmark populated, enforcement badge resolved.
    assert.ok(
      await cdp.waitFor(`document.querySelector('.shell-wordmark')?.textContent?.trim() === 'Workflow'`),
      "shell header wordmark must render",
    );
    assert.ok(
      await cdp.waitFor(`/ADVISORY|ENFORCED|POLICY/i.test(document.querySelector('.enforcement-badge')?.textContent ?? '')`),
      "enforcement badge must resolve from 'connecting'",
    );

    // 2. Composer is present and focusable.
    assert.equal(await cdp.evaluate(`!!document.querySelector('.composer-input')`), true, "composer input must render");

    // 3. Submit a prompt through the real composer and watch it stream.
    await cdp.evaluate(`
      (() => {
        const input = document.querySelector('.composer-input');
        const setter = Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value",
        ).set;
        setter.call(input, "survey the operator surface");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('.composer form, form')?.requestSubmit?.();
      })()
    `);
    assert.ok(
      await cdp.waitFor(`!!document.querySelector('.msg-user')`, 5_000),
      "user bubble must render after submit",
    );
    assert.ok(
      await cdp.waitFor(`!!document.querySelector('.part-completion')`, 20_000),
      "completion marker must render when the fake agent settles",
    );
    assert.ok(
      await cdp.waitFor(`[...document.querySelectorAll('.msg-assistant')].some((el) => (el.textContent ?? '').includes('pickers'))`, 10_000),
      "assistant reply must render into the thread (each transcript item is its own message)",
    );

    // 4. Usage readout is live from the fake runtime's metering hook.
    assert.ok(
      await cdp.waitFor(`document.querySelector('.usage-meter')?.textContent?.includes('32.9k') ?? false`),
      "usage meter must show the metered context tokens",
    );

    // 5. Palette switch: pick Dracula from settings; the html attribute and the
    // computed background token must both change, and the base must return
    // after choosing the amber default.
    await cdp.evaluate(`document.querySelector('.config-gear')?.click()`);
    assert.ok(await cdp.waitFor(`!!document.querySelector('.settings-dialog')`, 5_000), "settings dialog must open from the gear");
    await cdp.evaluate(`
      (() => {
        const chips = [...document.querySelectorAll('.palette-chip')];
        chips.find((chip) => chip.textContent?.includes('Dracula'))?.click();
      })()
    `);
    assert.ok(
      await cdp.waitFor(`document.documentElement.dataset.palette === 'dracula'`),
      "choosing a palette must set the data-palette attribute",
    );
    const themedBg = await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);
    assert.ok(themedBg !== "" && themedBg !== "#14161a", `palette must change --bg (got ${themedBg})`);
    await cdp.evaluate(`
      (() => {
        const chips = [...document.querySelectorAll('.palette-chip')];
        chips.find((chip) => chip.textContent?.includes('Workflow amber'))?.click();
      })()
    `);
    assert.ok(
      await cdp.waitFor(`document.documentElement.dataset.palette === undefined || !('palette' in document.documentElement.dataset)`, 5_000),
      "choosing the amber default must clear the palette attribute",
    );

    // 6. Page health: no uncaught exceptions, no console errors.
    assert.deepEqual(cdp.exceptions, [], "no uncaught exceptions on load and during the turn");
    assert.deepEqual(cdp.consoleErrors, [], "no console errors on load and during the turn");

    await cdp.close();
  } finally {
    browser.child.kill();
    try { rmSync(browser.dataDir, { recursive: true, force: true }); } catch { /* temp dir best effort */ }
    demo.close();
  }
});
