import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkflowRuntimeProvider, useSessionState } from "../src/ui/webapp/runtime.js";

// The #334-review storage residual the board-shell slice deliberately
// excluded: runtime.tsx read window.localStorage (workflow.show-thinking)
// UNGUARDED in the useState initializer and wrote it unguarded in the
// toggle's update callback — a storage-denied browser (block-all-cookies
// throws on the property access; getItem/setItem reject at call time; quota)
// crashed the panel render path. The honest behavior mirrors app.tsx's
// readLastUsed/writeLastUsed precedent: the read degrades to showThinking's
// own default (true — never a fabricated false), the write no-ops, nothing
// throws. Two denial shapes are modeled distinctly: the throwing storage
// stub below is the CALL-TIME denial (the property access succeeds;
// getItem/setItem reject); the throwing property getter is the ACCESS-TIME
// denial (the localStorage property itself throws — the browser
// block-all-cookies shape).
// Focused-run discipline: node --import tsx --test test/runtime-storage-guard.test.ts.
// (Template literals are deliberately absent: string concatenation keeps the
// source patchable under the guard shell classifier.)

const deniedStorage = {
  getItem: (): string | null => {
    throw new Error("storage denied");
  },
  setItem: (): void => {
    throw new Error("quota exceeded");
  },
};

/** A window stub whose localStorage property holds the given (possibly
 * hostile) implementation; defineProperty sidesteps the readonly DOM type
 * without faking a full Window. */
function windowWithStorage(storage: unknown): typeof globalThis.window {
  const stub = {} as typeof globalThis.window;
  Object.defineProperty(stub, "localStorage", { value: storage });
  return stub;
}

let capturedSetter: ((value: boolean) => void) | undefined;

/** Probe child: surfaces the panel's showThinking state in the markup and
 * captures the toggle setter for the write-path pins. */
function Probe(): ReactElement {
  const state = useSessionState();
  capturedSetter = state.setShowThinking;
  return createElement("div", null, "show-thinking=" + String(state.showThinking));
}

function renderPanel(): string {
  capturedSetter = undefined;
  return renderToStaticMarkup(createElement(WorkflowRuntimeProvider, { children: createElement(Probe) }));
}

function withDeniedWindow(window: typeof globalThis.window, run: () => void): void {
  const previousWindow = globalThis.window;
  globalThis.window = window;
  try {
    run();
  } finally {
    globalThis.window = previousWindow;
  }
}

test("show-thinking residual: a storage whose getItem throws yields the honest default on render — the panel render path never throws", () => {
  withDeniedWindow(windowWithStorage(deniedStorage), () => {
    let markup = "";
    assert.doesNotThrow(() => {
      markup = renderPanel();
    }, "a call-time storage denial must not crash the panel render path");
    assert.ok(markup.includes("show-thinking=true"), "the honest default — showThinking's own default true, never a fabricated false");
  });
});

test("show-thinking residual: a localStorage property that throws on access (the browser block-all-cookies shape) also yields the honest default and never throws", () => {
  const deniedWindow = {} as typeof globalThis.window;
  Object.defineProperty(deniedWindow, "localStorage", {
    get() {
      throw new Error("storage denied on access");
    },
  });
  withDeniedWindow(deniedWindow, () => {
    let markup = "";
    assert.doesNotThrow(() => {
      markup = renderPanel();
    }, "an access-time storage denial must not crash the panel render path");
    assert.ok(markup.includes("show-thinking=true"), "the honest default when the property ACCESS itself throws");
    const setter = capturedSetter;
    assert.ok(setter, "the probe captured the panel's toggle setter");
    assert.doesNotThrow(() => setter(false), "an access-time refusal no-ops the write — the toggle path never throws");
  });
});

test("show-thinking residual: a refused write no-ops — the toggle path never throws", () => {
  withDeniedWindow(windowWithStorage(deniedStorage), () => {
    renderPanel(); // the guarded read renders on the honest default
    const setter = capturedSetter;
    assert.ok(setter, "the probe captured the panel's toggle setter");
    assert.doesNotThrow(() => setter(false), "a refused save no-ops — the toggle path never throws");
  });
});

test("show-thinking residual (guard): a healthy storage still round-trips through the toggle — the unguarded contract is preserved", () => {
  const backing = new Map<string, string>();
  withDeniedWindow(windowWithStorage({
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => void backing.set(key, value),
  }), () => {
    assert.ok(renderPanel().includes("show-thinking=true"), "the absent key renders the honest default");
    const setter = capturedSetter;
    assert.ok(setter, "the probe captured the panel's toggle setter");
    setter(false);
    assert.equal(backing.get("workflow.show-thinking"), "false", "the toggle still persists through a healthy storage");
    assert.ok(renderPanel().includes("show-thinking=false"), "the guarded read still honors the persisted choice on the next render");
  });
});