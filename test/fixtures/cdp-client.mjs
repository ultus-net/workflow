/**
 * Zero-dependency CDP client for the Workflow browser e2e: speaks the raw
 * Chrome DevTools Protocol over Node 22's global WebSocket. No playwright,
 * no puppeteer — the repo's webapp tests must run with `npm ci` alone.
 *
 * Usage:
 *   const cdp = await connectCdp(browserWsUrl, "http://[IP_ADDRESS]:4173/");
 *   await cdp.evaluate("document.title");
 */
import { accessSync, readdirSync, constants } from "node:fs";

const X_OK = constants.X_OK;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a page target on the browser endpoint and attaches to it. */
export async function connectCdp(browserWsUrl, url) {
  const ws = new WebSocket(browserWsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP websocket failed")); });

  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
    // Surface page health to the caller even without a session subscription.
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.text ?? "exception");
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
  });

  const { result: target } = await send("Target.createTarget", { url: "about:blank" });
  const { result: attached } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;

  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (response?.result?.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(response.result.exceptionDetails)}`);
    }
    return response?.result?.result?.value;
  };

  /** Waits until the expression is truthy (or times out). */
  const waitFor = async (expression, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };

  return {
    sessionId,
    consoleErrors,
    exceptions,
    evaluate,
    waitFor,
    async close() {
      await send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      ws.close();
    },
  };
}

/** Finds a Chrome executable worth trying, or null when none exists. Env
 * override first, then the Playwright cache, then well-known system paths. */
export function findChromeExecutable() {
  const candidates = [];
  if (process.env.WORKFLOW_CHROME !== undefined && process.env.WORKFLOW_CHROME !== "") {
    candidates.push(process.env.WORKFLOW_CHROME);
  }
  try {
    const home = process.env.HOME ?? "";
    if (home !== "") {
      const cache = `${home}/.cache/ms-playwright`;
      const dirs = readdirSync(cache).filter((entry) => entry.startsWith("chromium")).sort().reverse();
      for (const dir of dirs) {
        candidates.push(`${cache}/${dir}/chrome-linux64/chrome`);
        candidates.push(`${cache}/${dir}/chrome-linux/chrome`);
      }
    }
  } catch { /* no playwright cache */ }
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/snap/bin/chromium");
  for (const candidate of candidates) {
    try {
      accessSync(candidate, X_OK);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}
