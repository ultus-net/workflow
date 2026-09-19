import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIMITS,
  boundedDuration,
  normalizeKey,
  validateAction,
  validateAssertion,
  validateHttpUrl,
  type BrowserAction,
  type BrowserAssertion,
  type Profile,
  type ValidatedUrl,
} from "./bounds.js";
import { CdpClient, connectWebSocketCdp, discoverChromeWebSocket } from "./cdp.js";
import {
  buildEvidence,
  pageHash,
  sha256,
  type BrowserEvidenceRecord,
  type BrowserEvidenceResult,
} from "./evidence.js";

export interface SessionConfig {
  readonly cdpUrl: string | undefined;
  readonly chromePath: string | undefined;
  readonly chromeArgs: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly profile: Profile;
  readonly commandTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly maxScreenshotBytes: number;
  readonly maxScreenshots: number;
}

function splitList(value: string | undefined, delimiter: string): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseChromeArgs(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return parsed as string[];
  } catch {
    throw new Error("BROWSER_VERIFICATION_CHROME_ARGS must be a JSON array of strings.");
  }
}

export function sessionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  const profile = env.BROWSER_VERIFICATION_PROFILE ?? "verification";
  if (profile !== "verification" && profile !== "debug") throw new Error("BROWSER_VERIFICATION_PROFILE must be verification or debug.");
  const rawCommandTimeout = Number(env.BROWSER_VERIFICATION_COMMAND_TIMEOUT_MS);
  const rawNavigationTimeout = Number(env.BROWSER_VERIFICATION_NAVIGATION_TIMEOUT_MS);
  return {
    cdpUrl: env.BROWSER_VERIFICATION_CDP_URL,
    chromePath: env.BROWSER_VERIFICATION_CHROME_PATH,
    chromeArgs: parseChromeArgs(env.BROWSER_VERIFICATION_CHROME_ARGS),
    allowedOrigins: splitList(env.BROWSER_VERIFICATION_ALLOWED_ORIGINS, ","),
    profile,
    commandTimeoutMs: boundedDuration(rawCommandTimeout, LIMITS.defaultCommandTimeoutMs, 500, LIMITS.maxCommandTimeoutMs),
    navigationTimeoutMs: boundedDuration(rawNavigationTimeout, LIMITS.defaultNavigationTimeoutMs, 500, LIMITS.maxNavigationTimeoutMs),
    maxScreenshotBytes: LIMITS.maxScreenshotBytes,
    maxScreenshots: LIMITS.maxScreenshotsPerSession,
  };
}

interface AxNodeView {
  readonly role: string;
  readonly name: string;
  readonly value: string;
}

interface AxSnapshot {
  readonly nodes: AxNodeView[];
  readonly truncated: boolean;
  readonly total: number;
  readonly hash: string;
}

interface TargetView {
  readonly url: string;
  readonly title: string;
}

export interface NavigateResult {
  readonly evidence: BrowserEvidenceRecord;
  readonly url: string;
  readonly title: string;
}

export interface SnapshotResult {
  readonly evidence: BrowserEvidenceRecord;
  readonly nodes: AxNodeView[];
  readonly truncated: boolean;
  readonly total: number;
}

export interface ActionOutcome {
  readonly evidence: BrowserEvidenceRecord;
  readonly detail: Record<string, unknown>;
}

export interface ScreenshotOutcome {
  readonly evidence: BrowserEvidenceRecord;
  readonly data: string;
  readonly mimeType: "image/png";
  readonly hash: string;
  readonly bytes: number;
}

export interface AssertionOutcome {
  readonly assertion: BrowserAssertion;
  readonly passed: boolean;
  readonly detail: string;
}

export interface AssertResult {
  readonly evidence: BrowserEvidenceRecord;
  readonly outcome: AssertionOutcome;
}

export interface VerificationInput {
  readonly url: string;
  readonly actions: readonly BrowserAction[];
  readonly assertions: readonly BrowserAssertion[];
  readonly screenshot: boolean;
}

export interface VerificationOutcome {
  readonly evidence: BrowserEvidenceRecord;
  readonly steps: ReadonlyArray<{ readonly step: string; readonly ok: boolean; readonly detail: string }>;
  readonly screenshot: { readonly hash: string; readonly bytes: number } | undefined;
}

export interface DebugCapture {
  readonly evidence: BrowserEvidenceRecord;
  readonly entries: ReadonlyArray<Record<string, unknown>>;
  readonly truncated: boolean;
}

interface LaunchedChrome {
  readonly wsUrl: string;
  readonly child: ChildProcess;
  readonly userDataDir: string;
}

async function launchChrome(config: SessionConfig): Promise<LaunchedChrome> {
  if (!config.chromePath) throw new Error("Chrome launch requested without a configured executable.");
  const userDataDir = await mkdtemp(join(tmpdir(), "browser-verification-chrome-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    ...config.chromeArgs,
    "about:blank",
  ];
  const child = spawn(config.chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for Chrome to report its DevTools endpoint."));
    }, 20_000);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (!match || !match[1]) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before reporting a DevTools endpoint (code ${code ?? "unknown"}).`));
    });
  }).catch(async (error: unknown) => {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  });
  return { wsUrl, child, userDataDir };
}

export class BrowserSession {
  private readonly evidence: BrowserEvidenceRecord[] = [];
  private screenshotCount = 0;
  private closed = false;
  private lastUrl = "about:blank";
  private lastTitle = "";

  private constructor(
    private readonly client: CdpClient,
    private readonly config: SessionConfig,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly launched: LaunchedChrome | undefined,
  ) {}

  static async start(config: SessionConfig, signal?: AbortSignal): Promise<BrowserSession> {
    let client: CdpClient;
    let launched: LaunchedChrome | undefined;
    if (config.cdpUrl) {
      const wsUrl = await discoverChromeWebSocket(config.cdpUrl, signal);
      client = await connectWebSocketCdp(wsUrl, config.commandTimeoutMs);
    } else if (config.chromePath) {
      launched = await launchChrome(config);
      client = await connectWebSocketCdp(launched.wsUrl, config.commandTimeoutMs);
    } else {
      throw new Error("No Chrome target configured. Set BROWSER_VERIFICATION_CDP_URL to a running Chrome or BROWSER_VERIFICATION_CHROME_PATH to launch one.");
    }
    try {
      const created = (await client.send("Target.createTarget", { url: "about:blank" })) as { targetId?: unknown };
      if (typeof created.targetId !== "string") throw new Error("Chrome did not return a target id.");
      const attached = (await client.send("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as { sessionId?: unknown };
      if (typeof attached.sessionId !== "string") throw new Error("Chrome did not attach to the target.");
      const session = new BrowserSession(client, config, created.targetId, attached.sessionId, launched);
      await client.send("Page.enable", {}, attached.sessionId);
      await client.send("DOM.enable", {}, attached.sessionId);
      await client.send("Accessibility.enable", {}, attached.sessionId);
      return session;
    } catch (error) {
      client.close();
      if (launched) await BrowserSession.disposeLauncher(launched);
      throw error;
    }
  }

  private static async disposeLauncher(launched: LaunchedChrome): Promise<void> {
    launched.child.kill("SIGKILL");
    await rm(launched.userDataDir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.send("Target.closeTarget", { targetId: this.targetId }, undefined, 2_000);
    } catch {
      // The target may already be gone; closing the transport still cleans up.
    }
    this.client.close();
    if (this.launched) await BrowserSession.disposeLauncher(this.launched);
  }

  private async target(): Promise<TargetView> {
    const info = (await this.client.send("Target.getTargetInfo", { targetId: this.targetId })) as {
      targetInfo?: { url?: unknown; title?: unknown };
    };
    const url = typeof info.targetInfo?.url === "string" ? info.targetInfo.url : this.lastUrl;
    const title = typeof info.targetInfo?.title === "string" ? info.targetInfo.title : this.lastTitle;
    this.lastUrl = url;
    this.lastTitle = title;
    return { url, title };
  }

  private async subject(): Promise<BrowserEvidenceRecord["subject"]> {
    const view = await this.target();
    let origin: string;
    try {
      origin = new URL(view.url).origin;
    } catch {
      origin = "about:blank";
    }
    return { kind: "browser_page", url: view.url, origin, pageHash: pageHash(view.url, view.title) };
  }

  private push(
    actionKind: BrowserEvidenceRecord["action"]["kind"],
    tool: string,
    detail: Record<string, unknown>,
    subject: BrowserEvidenceRecord["subject"],
    result: BrowserEvidenceResult,
    urlBefore: string,
  ): BrowserEvidenceRecord {
    const record = buildEvidence({
      capability: `browser-verification-mcp/${tool}`,
      profile: this.config.profile,
      actionKind,
      detail,
      subject,
      result,
      urlBefore,
      urlAfter: subject.url,
      provenance: { tool, targetId: this.targetId, sessionId: this.sessionId },
      previousHash: this.evidence.at(-1)?.hash ?? null,
    });
    this.evidence.push(record);
    if (this.evidence.length > LIMITS.maxEvidenceRecords) this.evidence.shift();
    return record;
  }

  listEvidence(limit: number): { records: BrowserEvidenceRecord[]; truncated: boolean } {
    const ordered = [...this.evidence].reverse();
    return { records: ordered.slice(0, limit), truncated: ordered.length > limit };
  }

  getEvidence(id: string): BrowserEvidenceRecord | undefined {
    return this.evidence.find((record) => record.id === id);
  }

  async navigate(url: string): Promise<NavigateResult> {
    const validated: ValidatedUrl = validateHttpUrl(url, this.config.allowedOrigins);
    const before = this.lastUrl;
    const loaded = this.client.waitFor("Page.loadEventFired", {
      timeoutMs: this.config.navigationTimeoutMs,
      filter: (event) => event.sessionId === this.sessionId,
    });
    void loaded.catch(() => undefined);
    await this.client.send("Page.navigate", { url: validated.url }, this.sessionId, this.config.navigationTimeoutMs);
    await loaded;
    const view = await this.target();
    const subject = { kind: "browser_page" as const, url: view.url, origin: validated.origin, pageHash: pageHash(view.url, view.title) };
    const evidence = this.push("navigate", "navigate", { requestedUrl: validated.url }, subject, { outcome: "observed", summary: `Navigated to ${view.url}`, truncated: false }, before);
    return { evidence, url: view.url, title: view.title };
  }

  async snapshotAccessibility(): Promise<SnapshotResult> {
    const before = this.lastUrl;
    const snapshot = await this.readAxTree();
    const subject = await this.subject();
    const evidence = this.push(
      "snapshot",
      "snapshot_accessibility",
      { nodeCount: snapshot.nodes.length, total: snapshot.total, axHash: snapshot.hash },
      subject,
      { outcome: "observed", summary: `Captured ${snapshot.nodes.length} of ${snapshot.total} accessibility nodes`, truncated: snapshot.truncated },
      before,
    );
    return { evidence, nodes: snapshot.nodes, truncated: snapshot.truncated, total: snapshot.total };
  }

  private async readAxTree(): Promise<AxSnapshot> {
    const tree = (await this.client.send("Accessibility.getFullAXTree", {}, this.sessionId)) as { nodes?: unknown };
    const rawNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    const nodes: AxNodeView[] = [];
    for (const raw of rawNodes) {
      if (nodes.length >= LIMITS.maxAxNodes) break;
      if (typeof raw !== "object" || raw === null) continue;
      const node = raw as { ignored?: unknown; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown } };
      if (node.ignored === true) continue;
      const role = typeof node.role?.value === "string" ? node.role.value : "";
      const name = typeof node.name?.value === "string" ? node.name.value : "";
      const value = typeof node.value?.value === "string" ? node.value.value : "";
      nodes.push({
        role: role.slice(0, LIMITS.maxAxNameChars),
        name: name.slice(0, LIMITS.maxAxNameChars),
        value: value.slice(0, LIMITS.maxAxNameChars),
      });
    }
    const total = rawNodes.filter((raw) => !(typeof raw === "object" && raw !== null && (raw as { ignored?: unknown }).ignored === true)).length;
    return { nodes, truncated: nodes.length < total, total, hash: sha256(JSON.stringify(nodes)) };
  }

  private async documentRoot(): Promise<number> {
    const document = (await this.client.send("DOM.getDocument", { depth: 0, pierce: false }, this.sessionId)) as { root?: { nodeId?: unknown } };
    if (typeof document.root?.nodeId !== "number") throw new Error("Chrome did not return a document root.");
    return document.root.nodeId;
  }

  private async querySelector(selector: string): Promise<number> {
    const root = await this.documentRoot();
    const result = (await this.client.send("DOM.querySelector", { nodeId: root, selector }, this.sessionId)) as { nodeId?: unknown };
    return typeof result.nodeId === "number" ? result.nodeId : 0;
  }

  private async requireNode(selector: string): Promise<number> {
    const nodeId = await this.querySelector(selector);
    if (nodeId === 0) throw new Error(`Selector matched no element: ${selector}`);
    return nodeId;
  }

  private async focusNode(nodeId: number): Promise<void> {
    await this.client.send("DOM.focus", { nodeId }, this.sessionId);
  }

  private async selectAll(): Promise<void> {
    await this.client.send(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 },
      this.sessionId,
    );
    await this.client.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 },
      this.sessionId,
    );
  }

  async performAction(action: BrowserAction): Promise<ActionOutcome> {
    const validated = validateAction(action);
    const before = this.lastUrl;
    let detail: Record<string, unknown>;
    switch (validated.kind) {
      case "click": {
        const nodeId = await this.requireNode(validated.selector);
        const quads = (await this.client.send("DOM.getContentQuads", { nodeId }, this.sessionId)) as { quads?: unknown };
        const first = Array.isArray(quads.quads) ? quads.quads[0] : undefined;
        if (!Array.isArray(first) || first.length < 8 || first.some((value) => typeof value !== "number")) throw new Error("Element has no clickable box.");
        const quad = first as number[];
        const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
        const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
        await this.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sessionId);
        await this.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.sessionId);
        await this.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, this.sessionId);
        detail = { selector: validated.selector, x, y };
        break;
      }
      case "type": {
        const nodeId = await this.requireNode(validated.selector);
        await this.focusNode(nodeId);
        await this.selectAll();
        await this.client.send("Input.insertText", { text: validated.text }, this.sessionId);
        detail = { selector: validated.selector, characters: validated.text.length };
        break;
      }
      case "clear": {
        const nodeId = await this.requireNode(validated.selector);
        await this.focusNode(nodeId);
        await this.selectAll();
        await this.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, this.sessionId);
        await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, this.sessionId);
        detail = { selector: validated.selector };
        break;
      }
      case "press": {
        if (validated.selector !== undefined) {
          const nodeId = await this.requireNode(validated.selector);
          await this.focusNode(nodeId);
        }
        const key = normalizeKey(validated.key);
        const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
        await this.client.send("Input.dispatchKeyEvent", key.text === undefined ? { type: "keyDown", ...base } : { type: "keyDown", ...base, text: key.text }, this.sessionId);
        await this.client.send("Input.dispatchKeyEvent", key.text === undefined ? { type: "keyUp", ...base } : { type: "keyUp", ...base, text: key.text }, this.sessionId);
        detail = { key: key.key, ...(validated.selector === undefined ? {} : { selector: validated.selector }) };
        break;
      }
      default: {
        const never: never = validated;
        throw new Error(`Unsupported action: ${JSON.stringify(never)}`);
      }
    }
    const subject = await this.subject();
    const evidence = this.push("action", "perform_action", detail, subject, { outcome: "observed", summary: `Performed ${validated.kind}`, truncated: false }, before);
    return { evidence, detail };
  }

  async takeScreenshot(): Promise<ScreenshotOutcome> {
    if (this.screenshotCount >= this.config.maxScreenshots) throw new Error(`Screenshot cap reached (${this.config.maxScreenshots} per session).`);
    const before = this.lastUrl;
    const captured = (await this.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, this.sessionId)) as { data?: unknown };
    if (typeof captured.data !== "string") throw new Error("Chrome did not return screenshot data.");
    const bytes = Buffer.byteLength(captured.data, "base64");
    if (bytes > this.config.maxScreenshotBytes) throw new Error(`Screenshot exceeds the ${this.config.maxScreenshotBytes}-byte cap.`);
    this.screenshotCount += 1;
    const hash = sha256(Buffer.from(captured.data, "base64"));
    const subject = await this.subject();
    const evidence = this.push(
      "screenshot",
      "take_screenshot",
      { mimeType: "image/png", bytes, hash },
      subject,
      { outcome: "observed", summary: `Captured a ${bytes}-byte screenshot`, truncated: false },
      before,
    );
    return { evidence, data: captured.data, mimeType: "image/png", hash, bytes };
  }

  private async evaluateAssertion(assertion: BrowserAssertion, ax: AxSnapshot | undefined): Promise<AssertionOutcome> {
    switch (assertion.kind) {
      case "text_visible":
      case "text_absent": {
        const snapshot = ax ?? (await this.readAxTree());
        const matched = snapshot.nodes.some((node) => node.name.includes(assertion.text) || node.value.includes(assertion.text));
        const passed = assertion.kind === "text_visible" ? matched : !matched;
        return { assertion, passed, detail: `${assertion.kind}("${assertion.text}") -> ${matched ? "found" : "not found"}` };
      }
      case "element_exists": {
        const nodeId = await this.querySelector(assertion.selector);
        return { assertion, passed: nodeId !== 0, detail: `${assertion.selector} -> ${nodeId === 0 ? "absent" : `node ${nodeId}`}` };
      }
      case "element_absent": {
        const nodeId = await this.querySelector(assertion.selector);
        return { assertion, passed: nodeId === 0, detail: `${assertion.selector} -> ${nodeId === 0 ? "absent" : `node ${nodeId}`}` };
      }
      case "attribute_equals": {
        const nodeId = await this.requireNode(assertion.selector);
        const attributes = (await this.client.send("DOM.getAttributes", { nodeId }, this.sessionId)) as { attributes?: unknown };
        const flat = Array.isArray(attributes.attributes) ? attributes.attributes : [];
        let actual: string | undefined;
        for (let index = 0; index + 1 < flat.length; index += 2) {
          if (flat[index] === assertion.name) actual = typeof flat[index + 1] === "string" ? (flat[index + 1] as string) : undefined;
        }
        const passed = actual === assertion.value;
        return { assertion, passed, detail: `${assertion.selector}[${assertion.name}] -> ${actual ?? "(missing)"}` };
      }
      case "url_contains": {
        const view = await this.target();
        return { assertion, passed: view.url.includes(assertion.text), detail: `url -> ${view.url}` };
      }
      case "title_contains": {
        const view = await this.target();
        return { assertion, passed: view.title.includes(assertion.text), detail: `title -> ${view.title}` };
      }
      default: {
        const never: never = assertion;
        throw new Error(`Unsupported assertion: ${JSON.stringify(never)}`);
      }
    }
  }

  async runAssertion(assertion: BrowserAssertion): Promise<AssertResult> {
    const validated = validateAssertion(assertion);
    const before = this.lastUrl;
    const outcome = await this.evaluateAssertion(validated, undefined);
    const subject = await this.subject();
    const evidence = this.push(
      "assert",
      "run_assertion",
      { assertion: validated, passed: outcome.passed, detail: outcome.detail },
      subject,
      { outcome: outcome.passed ? "passed" : "failed", summary: outcome.detail, assertions: { passed: outcome.passed ? 1 : 0, failed: outcome.passed ? 0 : 1 }, truncated: false },
      before,
    );
    return { evidence, outcome };
  }

  async runVerification(input: VerificationInput): Promise<VerificationOutcome> {
    const validatedUrl = validateHttpUrl(input.url, this.config.allowedOrigins);
    const actions = input.actions.map((action) => validateAction(action));
    const assertions = input.assertions.map((assertion) => validateAssertion(assertion));
    const before = this.lastUrl;
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    await this.navigate(validatedUrl.url);
    steps.push({ step: "navigate", ok: true, detail: validatedUrl.url });
    for (const [index, action] of actions.entries()) {
      await this.performAction(action);
      steps.push({ step: `action[${index}]:${action.kind}`, ok: true, detail: JSON.stringify(action) });
    }
    const needsAx = assertions.some((assertion) => assertion.kind === "text_visible" || assertion.kind === "text_absent");
    const ax = needsAx ? await this.readAxTree() : undefined;
    let passed = 0;
    let failed = 0;
    for (const [index, assertion] of assertions.entries()) {
      let outcome: AssertionOutcome;
      try {
        outcome = await this.evaluateAssertion(assertion, ax);
      } catch (error) {
        outcome = { assertion, passed: false, detail: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.passed) passed += 1;
      else failed += 1;
      steps.push({ step: `assert[${index}]:${assertion.kind}`, ok: outcome.passed, detail: outcome.detail });
    }
    let screenshot: { hash: string; bytes: number } | undefined;
    if (input.screenshot) {
      const captured = await this.takeScreenshot();
      screenshot = { hash: captured.hash, bytes: captured.bytes };
    }
    const outcome: BrowserEvidenceResult["outcome"] = assertions.length === 0 ? "inconclusive" : failed === 0 ? "passed" : "failed";
    const subject = await this.subject();
    const evidence = this.push(
      "verify_flow",
      "run_verification",
      {
        requestedUrl: validatedUrl.url,
        actionCount: actions.length,
        assertionCount: assertions.length,
        steps,
        ...(screenshot === undefined ? {} : { screenshot }),
      },
      subject,
      {
        outcome,
        summary: `Browser verification ${outcome} (${passed} passed, ${failed} failed)`,
        assertions: { passed, failed },
        truncated: false,
      },
      before,
    );
    return { evidence, steps, screenshot };
  }

  async captureDebug(kind: "console" | "network" | "trace", durationMs: number): Promise<DebugCapture> {
    const duration = boundedDuration(durationMs, 1_000, LIMITS.minDebugDurationMs, LIMITS.maxDebugDurationMs);
    const before = this.lastUrl;
    const entries: Array<Record<string, unknown>> = [];
    let truncated = false;
    if (kind === "console") {
      const remove = this.client.on("Runtime.consoleAPICalled", (event) => {
        if (event.sessionId !== this.sessionId) return;
        if (entries.length >= LIMITS.maxConsoleMessages) {
          truncated = true;
          return;
        }
        const args = Array.isArray(event.params.args) ? event.params.args : [];
        const text = args
          .map((arg) => (typeof arg === "object" && arg !== null && typeof (arg as { value?: unknown }).value === "string" ? ((arg as { value: string }).value as string) : ""))
          .join(" ")
          .slice(0, LIMITS.maxAxNameChars);
        entries.push({ type: typeof event.params.type === "string" ? event.params.type : "log", text });
      });
      await this.client.send("Runtime.enable", {}, this.sessionId);
      await new Promise((resolve) => setTimeout(resolve, duration));
      remove();
    } else if (kind === "network") {
      const seen = new Map<string, Record<string, unknown>>();
      const removeRequest = this.client.on("Network.requestWillBeSent", (event) => {
        if (event.sessionId !== this.sessionId) return;
        if (seen.size >= LIMITS.maxNetworkRequests) {
          truncated = true;
          return;
        }
        const requestId = typeof event.params.requestId === "string" ? event.params.requestId : "";
        const request = (event.params.request as { url?: unknown } | undefined) ?? {};
        seen.set(requestId, { requestId, url: typeof request.url === "string" ? request.url.slice(0, 2_048) : "", status: 0 });
      });
      const removeResponse = this.client.on("Network.responseReceived", (event) => {
        if (event.sessionId !== this.sessionId) return;
        const requestId = typeof event.params.requestId === "string" ? event.params.requestId : "";
        const existing = seen.get(requestId);
        const response = (event.params.response as { status?: unknown } | undefined) ?? {};
        if (existing && typeof response.status === "number") existing.status = response.status;
      });
      await this.client.send("Network.enable", {}, this.sessionId);
      await new Promise((resolve) => setTimeout(resolve, duration));
      removeRequest();
      removeResponse();
      entries.push(...seen.values());
    } else {
      const collected: Array<Record<string, unknown>> = [];
      const remove = this.client.on("Tracing.dataCollected", (event) => {
        if (event.sessionId !== this.sessionId) return;
        const value = (event.params.value as { traceEvents?: unknown } | undefined) ?? {};
        if (!Array.isArray(value.traceEvents)) return;
        for (const traceEvent of value.traceEvents) {
          if (collected.length >= LIMITS.maxTraceEvents) {
            truncated = true;
            break;
          }
          if (typeof traceEvent === "object" && traceEvent !== null) {
            const name = (traceEvent as { name?: unknown }).name;
            collected.push({ name: typeof name === "string" ? name.slice(0, 200) : "unknown" });
          }
        }
      });
      await this.client.send("Tracing.start", { categories: "-*", transferMode: "ReportEvents" }, this.sessionId);
      await new Promise((resolve) => setTimeout(resolve, duration));
      const complete = this.client.waitFor("Tracing.tracingComplete", { timeoutMs: this.config.commandTimeoutMs + duration, filter: (event) => event.sessionId === this.sessionId });
      void complete.catch(() => undefined);
      await this.client.send("Tracing.end", {}, this.sessionId);
      await complete.catch(() => undefined);
      remove();
      entries.push(...collected);
    }
    const subject = await this.subject();
    const evidence = this.push(
      "debug",
      `capture_${kind}`,
      { kind, durationMs: duration, count: entries.length },
      subject,
      { outcome: "observed", summary: `Captured ${entries.length} ${kind} entries over ${duration}ms`, truncated },
      before,
    );
    return { evidence, entries, truncated };
  }
}