import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";

import type { OperatorSessionItem } from "../operator-session.js";
import type { SessionUsageReadout } from "../web-session-channel.js";
import { convertOperatorItem } from "./messages.js";

const POLL_MS = 1000;

/** Session usage for the readout: full counters when metered (the loopback
 * usage proxy), only the ACP-reported fields when unmetered (OpenCode). */
export type SessionUsage = SessionUsageReadout;

interface SessionEnvelope {
  readonly available: boolean;
  readonly id?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly agentVersion?: string;
  readonly error?: string;
  readonly state: { readonly state: string };
  readonly items: readonly OperatorSessionItem[];
  readonly usage?: SessionUsage;
  /** Slash commands the agent advertised (ACP available_commands_update). */
  readonly commands?: readonly SessionCommand[];
}

/** One agent-advertised slash command (ACP available_commands_update). */
export interface SessionCommand {
  readonly name: string;
  readonly description: string;
}

const SessionUsageContext = createContext<SessionUsage | undefined>(undefined);

/** Latest metering metrics for the active session; undefined when unmetered. */
export function useSessionUsage(): SessionUsage | undefined {
  return useContext(SessionUsageContext);
}

/** The focused session's live agent identity (handshake facts). */
const AgentIdentityContext = createContext<{ readonly agent?: string | undefined; readonly version?: string | undefined }>({});

export function useAgentIdentity(): { readonly agent?: string | undefined; readonly version?: string | undefined } {
  return useContext(AgentIdentityContext);
}

const SessionCommandsContext = createContext<readonly SessionCommand[]>([]);

/** Slash commands the active agent advertised; empty until/unless it does. */
export function useSessionCommands(): readonly SessionCommand[] {
  return useContext(SessionCommandsContext);
}

const SessionStatusContext = createContext<{ readonly state: string; readonly error?: string }>({ state: "connecting" });

/** The live session's state and any spawn error (why it is unavailable). */
export function useSessionStatus(): { readonly state: string; readonly error?: string } {
  return useContext(SessionStatusContext);
}

const SessionStateContext = createContext<{
  readonly isRunning: boolean;
  readonly items: readonly OperatorSessionItem[];
  readonly queuedPrompt: string | undefined;
  readonly discardQueue: () => void;
  readonly queuePrompt: (text: string) => void;
  readonly showThinking: boolean;
  readonly setShowThinking: (value: boolean) => void;
}>({
  isRunning: false,
  items: [],
  queuedPrompt: undefined,
  discardQueue: () => {},
  queuePrompt: () => {},
  showThinking: true,
  setShowThinking: () => {},
});

/** Active-session state for tail affordances (regenerate, export, queue). */
export function useSessionState(): Readonly<{
  readonly isRunning: boolean;
  readonly items: readonly OperatorSessionItem[];
  readonly queuedPrompt: string | undefined;
  readonly discardQueue: () => void;
  readonly queuePrompt: (text: string) => void;
  readonly showThinking: boolean;
  readonly setShowThinking: (value: boolean) => void;
}> {
  return useContext(SessionStateContext);
}

/** Whether agent thinking blocks render in the transcript (presentation-only). */
const SHOW_THINKING_KEY = "workflow.show-thinking";

function readShowThinking(): boolean {
  // A storage-denied browser (block-all-cookies throws on the property
  // access itself; getItem rejects at call time) degrades to the toggle's
  // own default, never a fabricated false.
  try {
    return window.localStorage.getItem(SHOW_THINKING_KEY) !== "false";
  } catch {
    return true;
  }
}

function useShowThinking(): readonly [boolean, (value: boolean) => void] {
  const [showThinking, setShowThinking] = useState(readShowThinking);
  const update = useCallback((value: boolean): void => {
    try {
      window.localStorage.setItem(SHOW_THINKING_KEY, String(value));
    } catch {
      // Private browsing or quota: persistence is best-effort.
    }
    setShowThinking(value);
  }, []);
  return [showThinking, update];
}

/** The completion-notification preference key; the settings dialog owns the write. */
const NOTIFY_KEY = "workflow.notify-completion";

/** Whether the operator opted in to completion notifications (exported for the storage-guard pins). */
export function readNotifyCompletion(): boolean {
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === "true";
  } catch {
    // Storage withheld (block-all-cookies, quota): reads as the absent-key default - off.
    return false;
  }
}

/** Polls the Workflow-owned session projection; the browser holds no authority.
 * With a sessionId the poll targets that parallel live session explicitly. */
function useWorkflowSession(sessionId: string | undefined) {
  const [envelope, setEnvelope] = useState<SessionEnvelope>({ available: false, state: { state: "connecting" }, items: [] });
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(sessionId === undefined ? "/api/session" : `/api/session?session=${encodeURIComponent(sessionId)}`);
      if (!response.ok) return;
      setEnvelope(await response.json() as SessionEnvelope);
    } catch {
      // Keep the last good snapshot; the next poll retries.
    }
  }, [sessionId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { envelope, refresh: load };
}

const attachments = new SimpleImageAttachmentAdapter();

export function WorkflowRuntimeProvider({ children, sessionId, onCommandSession }: {
  readonly children: ReactNode;
  /** The parallel session the chat view is focused on; undefined = server focus. */
  readonly sessionId?: string | undefined;
  /** A prompt that begins with a slash command: return true when the app
   * handled it, false to send it to the agent like any prompt. */
  readonly onCommandSession?: ((command: string) => boolean) | undefined;
}) {
  const { envelope, refresh } = useWorkflowSession(sessionId);
  const isRunning = envelope.state.state === "running";
  const [queuedPrompt, setQueuedPrompt] = useState<string | undefined>(undefined);
  const [seenState, setSeenState] = useState("connecting");
  const [showThinking, setShowThinking] = useShowThinking();

  const sendPrompt = useCallback(async (prompt: string, images: readonly { readonly mediaType: string; readonly data: string }[] = []): Promise<void> => {
    // Slash commands are app commands first (true = handled), then agent
    // commands — the composer never turns them into a plain prompt.
    if (prompt.trim().startsWith("/") && onCommandSession !== undefined && onCommandSession(prompt.trim()) === true) return;
    const suffix = sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId)}`;
    const response = await fetch(`/api/prompt${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, ...(images.length > 0 ? { images } : {}) }),
    });
    // A turn is still running: hold the prompt and send it when the agent frees.
    if (response.status === 409) {
      setQueuedPrompt(prompt);
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(`prompt rejected: ${response.status}`);
    // The server records the user turn before accepting, so an immediate
    // refresh shows it without waiting for the next poll tick.
    await refresh();
  }, [refresh, sessionId, onCommandSession]);

  // Queue-while-running: the moment the turn settles, the queued prompt goes out.
  useEffect(() => {
    if (isRunning || queuedPrompt === undefined) return;
    setQueuedPrompt(undefined);
    void sendPrompt(queuedPrompt).catch(() => undefined);
  }, [isRunning, queuedPrompt, sendPrompt]);

  // Switching sessions discards any queued prompt: it belonged to the old thread.
  useEffect(() => {
    setQueuedPrompt(undefined);
  }, [envelope.id]);

  // Completion notification: desktop ping (when hidden and opted in) plus a
  // short chime — the operator can leave the tab while the agent works.
  useEffect(() => {
    const previous = seenState;
    setSeenState(envelope.state.state);
    const finished = envelope.state.state === "completed" || envelope.state.state === "failed";
    if (previous !== "running" || !finished) return;
    if (!readNotifyCompletion() || document.hidden === false) return;
    const body = envelope.state.state === "completed" ? "The agent finished its turn." : "The agent turn failed.";
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Workflow", { body });
    }
    completionChime(envelope.state.state === "completed");
  }, [envelope.state.state, seenState]);

  const onNew = useCallback(async (message: AppendMessage): Promise<void> => {
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    const images = (message.attachments ?? []).flatMap((attachment) =>
      attachment.content.flatMap((part) => {
        if (part.type !== "image") return [];
        const parsed = parseDataUrl(part.image);
        return parsed === undefined ? [] : [parsed];
      }),
    );
    if (text.length === 0 && images.length === 0) throw new Error("A prompt needs text or an image");
    await sendPrompt(text.length > 0 ? text : "Describe the attached image(s)", images);
  }, [sendPrompt]);

  const onCancel = useCallback(async (): Promise<void> => {
    await fetch(sessionId === undefined ? "/api/cancel" : `/api/cancel?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
    await refresh();
  }, [refresh, sessionId]);

  const discardQueue = useCallback((): void => {
    setQueuedPrompt(undefined);
  }, []);

  // Composer-level queueing: the aui composer swallows Enter while a run is
  // active, so the running-turn Enter path calls this instead of onNew.
  const queuePrompt = useCallback((text: string): void => {
    void sendPrompt(text).catch(() => undefined);
  }, [sendPrompt]);

  const runtime = useExternalStoreRuntime<OperatorSessionItem>({
    messages: envelope.items,
    convertMessage: (item, index) => convertOperatorItem(item, index, envelope.id ?? "single"),
    isRunning,
    isSendDisabled: !envelope.available,
    onNew,
    onCancel,
    adapters: { attachments },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionUsageContext.Provider value={envelope.usage}>
        <AgentIdentityContext.Provider value={{ agent: envelope.agent, version: envelope.agentVersion }}>
          <SessionStatusContext.Provider value={{ state: envelope.state.state, ...(envelope.error === undefined ? {} : { error: envelope.error }) }}>
            <SessionCommandsContext.Provider value={envelope.commands ?? []}>
              <SessionStateContext.Provider value={{ isRunning, items: envelope.items, queuedPrompt, discardQueue, queuePrompt, showThinking, setShowThinking }}>
                {children}
              </SessionStateContext.Provider>
            </SessionCommandsContext.Provider>
          </SessionStatusContext.Provider>
        </AgentIdentityContext.Provider>
      </SessionUsageContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/** Brief WebAudio chime so a finished turn is heard even from another tab. */
function completionChime(success: boolean): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = success ? 880 : 220;
    gain.gain.setValueAtTime(0.06, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
    // close() stops all audio processing — it must wait for the sound to end.
    oscillator.onended = () => {
      void context.close().catch(() => undefined);
    };
  } catch {
    // Audio can be unavailable (no device, autoplay policy); the ping is best-effort.
  }
}

/** Splits a data URL (data:<mediaType>;base64,<data>) into its wire parts. */
function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (match === null) return undefined;
  return { mediaType: match[1]!, data: match[2]! };
}
