// The completion-notification storage residual (the third same-class
// residual): runtime.tsx read window.localStorage (workflow.notify-completion)
// UNGUARDED inside the completion useEffect - a storage-denied browser
// (block-all-cookies throws on the property access itself; getItem rejects at
// call time) crashed the poll effect mid-flight. The honest behavior mirrors
// app.tsx readLastUsed: the read is guarded and degrades to the absent-key
// default (off - no notification), never a fabricated flip to on. Two denial
// shapes are pinned: the throwing storage stub is the CALL-TIME denial (the
// property access succeeds; getItem rejects); the throwing property getter is
// the ACCESS-TIME denial (the localStorage property itself throws - the
// browser block-all-cookies shape). renderToStaticMarkup never runs effects,
// so the effect path cannot be exercised at this tier: the read is pinned at
// its unit (the helper) and the effect is pinned to DELEGATE via the source
// pin below (the webapp-surface regex precedent); the client-renderer harness
// is the webui-e2e tier. Focused-run discipline:
// node --import tsx --test test/notify-storage-guard.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const NOTIFY_KEY = "workflow.notify-completion";

/** Installs a window stub for the duration of run; restores the ambient
 * window after (the helper reads window.localStorage directly). */
function withWindow(window: typeof globalThis.window, run: () => void): void {
  const previousWindow = globalThis.window;
  globalThis.window = window;
  try {
    run();
  } finally {
    globalThis.window = previousWindow;
  }
}

/** A window stub whose localStorage property holds the given (possibly
 * hostile) implementation; defineProperty sidesteps the readonly DOM type
 * without faking a full Window. */
function windowWithStorage(storage: unknown): typeof globalThis.window {
  const stub = {} as typeof globalThis.window;
  Object.defineProperty(stub, "localStorage", { value: storage });
  return stub;
}

async function helperFromSource(): Promise<(() => boolean) | undefined> {
  const runtime = await import("../src/ui/webapp/runtime.js");
  return runtime.readNotifyCompletion;
}

const deniedStorage = {
  getItem: (): string | null => {
    throw new Error("storage denied");
  },
};

test("notify-completion residual: a storage whose getItem throws at call time reads as the honest default - off, never a throw", async () => {
  const read = await helperFromSource();
  assert.ok(read, "runtime.tsx must export the guarded readNotifyCompletion helper (the pin needs the unit)");
  withWindow(windowWithStorage(deniedStorage), () => {
    assert.equal(read(), false, "a call-time denial reads as the absent-key default: off - never a fabricated flip to on, never a throw");
  });
});

test("notify-completion residual: a localStorage property that throws on access (the browser block-all-cookies shape) also reads as the honest default - off", async () => {
  const read = await helperFromSource();
  assert.ok(read, "runtime.tsx must export the guarded readNotifyCompletion helper (the pin needs the unit)");
  const deniedWindow = {} as typeof globalThis.window;
  Object.defineProperty(deniedWindow, "localStorage", {
    get() {
      throw new Error("storage denied on access");
    },
  });
  withWindow(deniedWindow, () => {
    assert.equal(read(), false, "an access-time denial reads as the absent-key default: off - the property ACCESS itself throws");
  });
});

test("notify-completion (guard): the guarded read honors the persisted preference - absent key off, opted-in on, explicit opt-out off", async () => {
  const read = await helperFromSource();
  assert.ok(read, "runtime.tsx must export the guarded readNotifyCompletion helper (the pin needs the unit)");
  const backing = new Map<string, string>();
  withWindow(windowWithStorage({
    getItem: (key: string): string | null => backing.get(key) ?? null,
  }), () => {
    assert.equal(read(), false, "the absent key reads off - the honest default, not a fabricated true");
    backing.set(NOTIFY_KEY, "true");
    assert.equal(read(), true, "the opted-in operator still gets the notification preference");
    backing.set(NOTIFY_KEY, "false");
    assert.equal(read(), false, "an explicit opt-out stays off");
  });
});

// The two-sided source pin (the webapp-surface regex precedent:
// test/webapp-surface.test.ts regexes source directly): the effect body must
// delegate the storage read to the guarded helper, and no direct
// window.localStorage read may be re-inlined into the notify region.
test("notify-completion residual (source pin): the completion effect delegates the storage read to the guarded helper", () => {
  const source = readFileSync(resolve("src/ui/webapp/runtime.tsx"), "utf8");
  // Negative-assertion scoping: runtime.tsx showThinking region legitimately
  // touches window.localStorage (its own guard lives on the sibling branch),
  // so the check is scoped to the notify region only - delimited by the
  // completion-notification banner above the effect and the effect own deps
  // line. The helper guarded read sits above the banner (it IS the fix) and
  // is deliberately outside the negative scope.
  const banner = "// Completion notification:";
  const regionStart = source.indexOf(banner);
  assert.ok(regionStart !== -1, "the completion-notification banner must exist (the notify region start marker)");
  const depsLine = "}, [envelope.state.state, seenState]);";
  const regionEnd = source.indexOf(depsLine, regionStart);
  assert.ok(regionEnd !== -1, "the notify effect deps line must exist (the notify region end marker)");
  const region = source.slice(regionStart, regionEnd);
  assert.ok(region.includes("readNotifyCompletion("), "the effect body must delegate the storage read to the guarded readNotifyCompletion helper");
  assert.ok(!region.includes("window.localStorage"), "no direct window.localStorage read in the notify region - re-inlining the unguarded read re-opens the crash");
});
