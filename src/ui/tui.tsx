import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { CodingSessionEvent } from "../application/coding-session.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowApplication, WorkflowSnapshot } from "../application/workflow.js";
import type { TaskState } from "../kernel/contracts.js";

export { createWorkflowRibbonFrames, renderWorkflowRibbon, WORKFLOW_RIBBON_FRAMES, WORKFLOW_RIBBON_PROJECT } from "./home-animation.js";

interface TranscriptEntry {
  readonly label: string;
  readonly text: string;
  readonly dim?: boolean;
}

export const WORKFLOW_MARK = `⠀⠀⠀⠀⠀⠀⠀⢀⣠⣴⣶⣾⣷⣶⣶⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⢀⣤⣶⣾⣿⣿⣿⣿⣿⣿⠋⢻⣿⣿⣿⣿⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠉⠉⠓⠲⠤⣤⣤⣬⣿⣿⣷⣿⣿⣿⣿⣿⣿⣿⣯⡁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠈⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡷⢤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠷⠦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⡟⠋⣠⣤⣶⣶⣦⣤⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⡟⠀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⠾⠋⣾⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⡿⣿⣿⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⡀⠻⣿⣿⣿⣿⡟⢿⣿⣿⣤⡙⠻⣿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢸⣿⠋⣿⣿⣿⣿⣿⣷⣄⠙⠿⣿⣿⣿⣦⡉⠛⢿⣿⣦⣌⠙⠿⣿⣶⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⡟⠀⢿⣿⣿⣿⣿⣿⣿⣷⣦⡘⠻⢿⣿⣿⣷⣦⣘⠻⣿⣿⣶⣜⡻⣿⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠁⠀⠈⢻⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣌⡙⠻⢿⣿⣿⣶⣭⣻⢿⣿⣶⣝⡻⢿⣦⡀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣄⡈⠙⠻⠿⣿⣶⣮⣝⣻⣷⣤⣈⠁⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣤⣀⠉⠛⠻⢿⣿⣿⣿⣿⣷⣄⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⡌⢻⣿⣿⣿⣿⠉⣿⣿⣿⣿⣿⣶⣦⣄⡈⠉⠛⠿⢿⣿⣿⣦⡀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣿⠿⠓⠀⢿⣿⣿⣿⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⠀⠀⠀⠀⠉⠛⠢⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣠⣾⡟⠁⠀⠀⠀⢸⣿⣿⠏⠀⢹⣿⢿⣿⣿⣿⣿⣿⡿⣿⣿⣄⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⢠⡾⠟⢛⣿⡿⠿⠿⠟⠛⠷⠀⣠⣿⠟⠁⠀⠀⠈⢿⣇⢻⣿⡟⢿⣿⣿⡌⢻⣿⣦⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠈⠁⣰⠟⠁⠀⣀⣀⣀⣀⣀⣾⡟⠁⠀⠀⠀⠀⠀⠈⠻⡄⢻⣿⡌⢿⣿⣿⣆⠹⣿⣷⡀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠀⢰⠿⠛⢋⣿⠿⠿⠿⠛⠛⠻⢦⠀⠀⠀⠀⠀⠀⠈⢿⣿⡄⢻⣿⣿⣦⠈⠛⠿⣄⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⡄⢻⣿⣿⣧⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠀⢻⣿⣿⣷⡄⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣄⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣦⡀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠳⠄`;

export function nextInteractiveState(state: TaskState): TaskState | undefined {
  if (state === "READY") return "IN_PROGRESS";
  if (state === "IN_PROGRESS") return "VERIFYING";
  if (state === "VERIFYING") return "VERIFIED";
  return undefined;
}

export function WorkflowTui({
  application,
  session,
}: {
  readonly application: WorkflowApplication;
  readonly session?: WorkflowCodingSession;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(() => application.snapshot());
  const [prompt, setPrompt] = useState("");
  const [sessionState, setSessionState] = useState(() => session?.snapshot());
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showWorkflow, setShowWorkflow] = useState(false);

  useEffect(() => session?.subscribe((event) => {
    setTranscript((current) => [...current, formatSessionEvent(event)]);
    setScrollOffset(0);
    setSessionState(session.snapshot());
    setSnapshot(application.snapshot());
  }), [application, session]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (sessionState?.state === "running" && session !== undefined) {
        void session.cancel().finally(() => setSessionState(session.snapshot()));
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "w") {
      setShowWorkflow((value) => !value);
      return;
    }
    if (key.pageUp) {
      setScrollOffset((value) => Math.min(transcript.length, value + 5));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((value) => Math.max(0, value - 5));
      return;
    }
    if (session === undefined || sessionState?.state === "running") return;
    if (key.escape) {
      setPrompt("");
      return;
    }
    if (key.return) {
      const submitted = prompt.trim();
      if (submitted.length === 0) return;
      setTranscript((current) => [...current, { label: "You", text: submitted }]);
      setPrompt("");
      setScrollOffset(0);
      setSessionState({ state: "running" });
      void session.submit(submitted).finally(() => {
        setSessionState(session.snapshot());
        setSnapshot(application.snapshot());
      });
      return;
    }
    if (key.backspace || key.delete) {
      setPrompt((value) => value.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) setPrompt((value) => value + input);
  });

  const transcriptRows = Math.max(4, (stdout.rows ?? 24) - (showWorkflow ? 16 : 10));
  const end = Math.max(0, transcript.length - scrollOffset);
  const visibleTranscript = transcript.slice(Math.max(0, end - transcriptRows), end);
  const taskSummary = summarizeTasks(snapshot);

  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="column" width="100%" maxWidth={68} paddingX={1}>
        <Box flexDirection="column" minHeight={4}>
        {transcript.length === 0 ? (
          <Box flexDirection="column" alignItems="center">
            <Text>{WORKFLOW_MARK}</Text>
            <Box marginTop={1}>
              <Text bold>What can I do for you?</Text>
            </Box>
            <Box marginTop={1} marginBottom={1}>
              <Text dimColor italic>Use / for slash commands, @ for file mentions, Ctrl+P for menu</Text>
            </Box>
          </Box>
        ) : null}
        {scrollOffset > 0 ? <Text dimColor>[{scrollOffset} newer lines below]</Text> : null}
        {visibleTranscript.map((entry, index) => (
          <Text key={`${end}-${index}-${entry.label}`} dimColor={entry.dim === true}>
            <Text bold={!entry.dim}>{entry.label.padEnd(10)}</Text>{entry.text}
          </Text>
        ))}
        </Box>

        {session !== undefined ? (
          <Box marginTop={1} flexDirection="column">
          <Text dimColor>----------------------------------------------------------------</Text>
          {sessionState?.state === "running" ? (
            <Text><Text bold>[running]</Text> Cline is working. Ctrl+C cancel</Text>
          ) : (
            <Text><Text bold>&gt;</Text> {prompt.length === 0 ? <Text dimColor>What do you want to build?</Text> : prompt}</Text>
          )}
          <Text dimColor>----------------------------------------------------------------</Text>
          <Box justifyContent="space-between">
            <Text dimColor>{sessionState?.state ?? "idle"} | PageUp/PageDown history</Text>
            <Text dimColor>Ctrl+C quit</Text>
          </Box>
          </Box>
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Text bold>Workflow</Text>
          <Text bold>{snapshot.enforcementLevel.toUpperCase()} / {snapshot.transport}</Text>
        </Box>
        <Text dimColor>{taskSummary} | epoch {snapshot.mutationEpoch} | Ctrl+W workflow</Text>

        {showWorkflow ? <WorkflowDetails snapshot={snapshot} /> : null}
      </Box>
    </Box>
  );
}

function WorkflowDetails({ snapshot }: { readonly snapshot: WorkflowSnapshot }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Workflow details</Text>
      {snapshot.tasks.length === 0 ? <Text dimColor>No workflow tasks.</Text> : snapshot.tasks.map((task) => (
        <Text key={task.id} dimColor={task.state === "BLOCKED"}>
          {task.id.padEnd(8)} {task.state.padEnd(11)} {task.title}{task.blockers.length > 0 ? ` [blocked by ${task.blockers.join(", ")}]` : ""}
        </Text>
      ))}
      <Text dimColor>
        evidence {snapshot.evidence.length} | transitions {snapshot.history.length} | Ctrl+W close
      </Text>
    </Box>
  );
}

function summarizeTasks(snapshot: WorkflowSnapshot): string {
  if (snapshot.tasks.length === 0) return "no tasks";
  const counts = new Map<TaskState, number>();
  for (const task of snapshot.tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  return [...counts.entries()].map(([state, count]) => `${count} ${state.toLowerCase()}`).join(" | ");
}

function formatSessionEvent(event: CodingSessionEvent): TranscriptEntry {
  if (event.type === "assistant") return { label: "Cline", text: event.text };
  if (event.type === "status") return { label: "[status]", text: event.status, dim: true };
  if (event.type === "tool-proposal") {
    return { label: "[tool]", text: `${event.tool}${event.subjects.length > 0 ? ` ${event.subjects.join(", ")}` : ""}`, dim: true };
  }
  if (event.type === "tool-outcome") {
    const marker = event.outcome === "succeeded" ? "[ok]" : `[${event.outcome}]`;
    return { label: marker, text: `${event.tool}${event.detail === undefined ? "" : `: ${event.detail}`}`, dim: event.outcome === "succeeded" };
  }
  if (event.type === "completed") return { label: "completed", text: event.result };
  return { label: "failed", text: event.reason };
}
