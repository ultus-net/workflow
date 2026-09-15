import { useCallback, useEffect, useState } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";

import { ActionPart, AttentionPart, CompletionPart, OutcomePart } from "./message-parts.js";
import { MarkdownText } from "./markdown-text.js";

interface SnapshotTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly blockers: readonly string[];
}

interface SnapshotEvidence {
  readonly subject: string;
  readonly result: string;
  readonly freshness: string;
}

interface SnapshotHistory {
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
}

interface Snapshot {
  readonly enforcementLevel: string;
  readonly transport: string;
  readonly tasks: readonly SnapshotTask[];
  readonly evidence: readonly SnapshotEvidence[];
  readonly history: readonly SnapshotHistory[];
}

const NEXT_STATE: Record<string, string> = { READY: "IN_PROGRESS", IN_PROGRESS: "VERIFYING", VERIFYING: "VERIFIED" };
const PANEL_POLL_MS = 1500;

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/snapshot");
      if (response.ok) setSnapshot(await response.json() as Snapshot);
    } catch {
      // Keep the last good snapshot; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { snapshot, refresh: load };
}

function advance(taskId: string, requested: string, refresh: () => Promise<void>): void {
  void fetch("/api/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, requested }),
  }).then(() => refresh());
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <MessagePrimitive.Attachments>
        {({ attachment }) => {
          const imagePart = attachment.content.find((part) => part.type === "image");
          return imagePart !== undefined && imagePart.type === "image"
            ? <img className="msg-attachment" src={imagePart.image} alt={attachment.name} />
            : null;
        }}
      </MessagePrimitive.Attachments>
      <MessagePrimitive.Parts components={{ Text: (part) => <p className="msg-text">{part.text}</p> }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          data: {
            by_name: {
              action: ActionPart,
              outcome: OutcomePart,
              attention: AttentionPart,
              completion: CompletionPart,
            },
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="composer">
      <div className="composer-attachments">
        <ComposerPrimitive.Attachments>
          {() => (
            <AttachmentPrimitive.Root className="composer-attachment">
              <AttachmentPrimitive.unstable_Thumb className="composer-attachment-thumb" />
              <span className="composer-attachment-name"><AttachmentPrimitive.Name /></span>
              <AttachmentPrimitive.Remove className="attachment-remove" aria-label="Remove attachment">×</AttachmentPrimitive.Remove>
            </AttachmentPrimitive.Root>
          )}
        </ComposerPrimitive.Attachments>
      </div>
      <div className="composer-row">
        <ComposerPrimitive.AddAttachment className="btn btn-ghost btn-attach" aria-label="Attach image" multiple>
          +
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder="Describe the work to perform"
          submitMode="enter"
          aria-label="Prompt"
        />
        <div className="composer-actions">
          <AuiIf condition={(state) => state.thread.isRunning}>
            <ComposerPrimitive.Cancel className="btn btn-cancel">Cancel</ComposerPrimitive.Cancel>
          </AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning}>
            <ComposerPrimitive.Send className="btn btn-send">Send</ComposerPrimitive.Send>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function Panels({ snapshot, refresh }: { readonly snapshot: Snapshot | undefined; readonly refresh: () => Promise<void> }) {
  return (
    <aside className="panels">
      <section>
        <h2>Tasks</h2>
        {(snapshot?.tasks ?? []).map((task) => (
          <div className={`task ${task.state === "BLOCKED" ? "task-blocked" : ""}`} key={task.id}>
            <strong>{task.id}</strong>
            <span className={`task-state task-state-${task.state.toLowerCase()}`}>{task.state}</span>
            <span className="task-title">
              {task.title}
              {task.blockers.length > 0 && <span className="task-blockers">blocked by {task.blockers.join(", ")}</span>}
            </span>
            {NEXT_STATE[task.state] !== undefined && (
              <button className="btn btn-ghost" onClick={() => advance(task.id, NEXT_STATE[task.state]!, refresh)}>
                Advance
              </button>
            )}
          </div>
        ))}
      </section>
      <section>
        <h2>Evidence</h2>
        {snapshot === undefined || snapshot.evidence.length === 0
          ? <p className="muted">none observed</p>
          : snapshot.evidence.map((entry, index) => (
            <p className={entry.freshness === "stale" ? "muted" : ""} key={index}>
              {entry.subject}: {entry.result} / {entry.freshness}
            </p>
          ))}
      </section>
      <section>
        <h2>History</h2>
        {snapshot === undefined || snapshot.history.length === 0
          ? <p className="muted">no transitions</p>
          : snapshot.history.slice(-8).map((entry, index) => (
            <p key={index}>{entry.taskId}: {entry.from} → {entry.to}</p>
          ))}
      </section>
    </aside>
  );
}

export function App() {
  const { snapshot, refresh } = useSnapshot();
  return (
    <div className="shell">
      <header className="shell-header">
        <strong>Workflow Control</strong>
        <span className="shell-host">
          {snapshot === undefined ? "connecting" : `${snapshot.enforcementLevel.toUpperCase()} / ${snapshot.transport}`}
        </span>
      </header>
      <main className="shell-main">
        <section className="chat-column">
          <ThreadPrimitive.Root className="thread-root">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <AuiIf condition={(state) => state.thread.isEmpty}>
                <div className="welcome">
                  <p>Describe the work to perform. Every action the agent takes is proposed and authorized through Workflow.</p>
                </div>
              </AuiIf>
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
              </ThreadPrimitive.Messages>
            </ThreadPrimitive.Viewport>
            <div className="composer-dock">
              <Composer />
            </div>
          </ThreadPrimitive.Root>
        </section>
        <Panels snapshot={snapshot} refresh={refresh} />
      </main>
    </div>
  );
}
