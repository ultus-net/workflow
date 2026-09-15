import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";

import type { OperatorSessionItem } from "../operator-session.js";
import { convertOperatorItem } from "./messages.js";

const POLL_MS = 1000;

interface SessionEnvelope {
  readonly available: boolean;
  readonly state: { readonly state: string };
  readonly items: readonly OperatorSessionItem[];
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

export function WorkflowRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const { envelope, refresh } = useWorkflowSession();
  const isRunning = envelope.state.state === "running";

  const onNew = useCallback(async (message: AppendMessage): Promise<void> => {
    const part = message.content[0];
    if (part?.type !== "text") throw new Error("Only text prompts are supported");
    const response = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: part.text }),
    });
    if (!response.ok) throw new Error(`prompt rejected: ${response.status}`);
    // The server records the user turn before accepting, so an immediate
    // refresh shows it without waiting for the next poll tick.
    await refresh();
  }, [refresh]);

  const onCancel = useCallback(async (): Promise<void> => {
    await fetch("/api/cancel", { method: "POST" });
    await refresh();
  }, [refresh]);

  const runtime = useExternalStoreRuntime<OperatorSessionItem>({
    messages: envelope.items,
    convertMessage: convertOperatorItem,
    isRunning,
    isSendDisabled: !envelope.available || isRunning,
    onNew,
    onCancel,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
