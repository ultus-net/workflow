import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
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

const attachments = new SimpleImageAttachmentAdapter();

export function WorkflowRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const { envelope, refresh } = useWorkflowSession();
  const isRunning = envelope.state.state === "running";

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
    const response = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text.length > 0 ? text : "Describe the attached image(s)", ...(images.length > 0 ? { images } : {}) }),
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
    adapters: { attachments },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** Splits a data URL (data:<mediaType>;base64,<data>) into its wire parts. */
function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (match === null) return undefined;
  return { mediaType: match[1]!, data: match[2]! };
}
