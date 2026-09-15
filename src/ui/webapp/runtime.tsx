import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";

import type { OperatorSessionItem } from "../operator-session.js";
import { convertOperatorItem } from "./messages.js";

const POLL_MS = 1000;

/** Cumulative metering metrics from the hub-side proxy (undefined when unmetered). */
export interface SessionUsage {
  readonly requests: number;
  readonly usageEvents: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

interface SessionEnvelope {
  readonly available: boolean;
  readonly id?: string;
  readonly title?: string;
  readonly state: { readonly state: string };
  readonly items: readonly OperatorSessionItem[];
  readonly usage?: SessionUsage;
}

const SessionUsageContext = createContext<SessionUsage | undefined>(undefined);

/** Latest metering metrics for the active session; undefined when unmetered. */
export function useSessionUsage(): SessionUsage | undefined {
  return useContext(SessionUsageContext);
}

const SessionStateContext = createContext<{
  readonly isRunning: boolean;
  readonly items: readonly OperatorSessionItem[];
  readonly queuedPrompt: string | undefined;
  readonly discardQueue: () => void;
  readonly queuePrompt: (text: string) => void;
}>({ isRunning: false, items: [], queuedPrompt: undefined, discardQueue: () => {}, queuePrompt: () => {} });

/** Active-session state for tail affordances (regenerate, export, queue). */
export function useSessionState(): Readonly<{
  readonly isRunning: boolean;
  readonly items: readonly OperatorSessionItem[];
  readonly queuedPrompt: string | undefined;
  readonly discardQueue: () => void;
  readonly queuePrompt: (text: string) => void;
}> {
  return useContext(SessionStateContext);
}

/** Polls the Workflow-owned session projection; the browser holds no authority. */
function useWorkflowSession() {
  const [envelope, setEnvelope] = useState<SessionEnvelope>({ available: false, state: { state: "connecting" }, items: [] });
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/session");
      if (!response.ok) return;
      setEnvelope(await response.json() as SessionEnvelope);
    } catch {
      // Keep the last good snapshot; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { envelope, refresh: load };
}

const attachments = new SimpleImageAttachmentAdapter();

export function WorkflowRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const { envelope, refresh } = useWorkflowSession();
  const isRunning = envelope.state.state === "running";
  const [queuedPrompt, setQueuedPrompt] = useState<string | undefined>(undefined);
  const [seenState, setSeenState] = useState("connecting");

  const sendPrompt = useCallback(async (prompt: string, images: readonly { readonly mediaType: string; readonly data: string }[] = []): Promise<void> => {
    const response = await fetch("/api/prompt", {
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
  }, [refresh]);

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
    if (window.localStorage.getItem("workflow.notify-completion") !== "true" || document.hidden === false) return;
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
    await fetch("/api/cancel", { method: "POST" });
    await refresh();
  }, [refresh]);

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
        <SessionStateContext.Provider value={{ isRunning, items: envelope.items, queuedPrompt, discardQueue, queuePrompt }}>
          {children}
        </SessionStateContext.Provider>
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
    void context.close().catch(() => undefined);
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
