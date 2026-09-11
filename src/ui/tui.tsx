import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { CodingSessionEvent } from "../application/coding-session.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowApplication, WorkflowSnapshot } from "../application/workflow.js";
import type { TaskState } from "../kernel/contracts.js";

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
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(() => application.snapshot());
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [prompting, setPrompting] = useState(false);
  const [sessionState, setSessionState] = useState(() => session?.snapshot());
  const [activity, setActivity] = useState<readonly string[]>([]);

  useEffect(() => session?.subscribe((event) => {
    setActivity((current) => [...current.slice(-7), formatSessionEvent(event)]);
    setSessionState(session.snapshot());
    setSnapshot(application.snapshot());
  }), [application, session]);

  useInput((input, key) => {
    if (prompting) {
      if (key.escape) {
        setPrompt("");
        return setPrompting(false);
      }
      if (key.return) {
        const submitted = prompt.trim();
        if (submitted.length === 0 || session === undefined) return;
        setPrompt("");
        setPrompting(false);
        setSessionState({ state: "running" });
        void session.submit(submitted).finally(() => {
          setSessionState(session.snapshot());
          setSnapshot(application.snapshot());
        });
        return;
      }
      if (key.backspace || key.delete) return setPrompt((value) => value.slice(0, -1));
      if (input.length > 0 && !key.ctrl && !key.meta) setPrompt((value) => value + input);
      return;
    }
    if (input === "q") return exit();
    if (input === "i" && session !== undefined) return setPrompting(true);
    if (input === "x" && sessionState?.state === "running" && session !== undefined) {
      void session.cancel().finally(() => setSessionState(session.snapshot()));
      return;
    }
    if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) return setSelected((value) => Math.min(snapshot.tasks.length - 1, value + 1));
    if (key.return) {
      const task = snapshot.tasks[selected];
      if (task === undefined) return;
      const next = nextInteractiveState(task.state);
      if (next === undefined) {
        setMessage(`No interactive advance from ${task.state}`);
        return;
      }
      const result = application.transition(task.id, next);
      setMessage(result.kind === "accepted" ? `${task.id}: ${task.state} -> ${next}` : result.reason);
      setSnapshot(application.snapshot());
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>WORKFLOW</Text>
        <Text bold>
          {snapshot.enforcementLevel.toUpperCase()} / {snapshot.transport}
        </Text>
      </Box>
      <Text dimColor>epoch {snapshot.mutationEpoch} | arrows select | enter advance | i prompt | x cancel | q quit</Text>

      {session !== undefined ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>SESSION {sessionState?.state ?? "idle"}</Text>
          {activity.length === 0 ? <Text dimColor>no coding activity</Text> : activity.map((item, index) => (
            <Text key={`${index}-${item}`} dimColor>{item}</Text>
          ))}
          {prompting ? <Text>&gt; {prompt}</Text> : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>TASKS</Text>
        {snapshot.tasks.map((task, index) => (
          <Text key={task.id} bold={index === selected} dimColor={task.state === "BLOCKED"}>
            {index === selected ? ">" : " "} {task.id.padEnd(8)} {task.state.padEnd(11)} {task.title}
            {task.blockers.length > 0 ? ` [blocked by ${task.blockers.join(", ")}]` : ""}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>EVIDENCE</Text>
        {snapshot.evidence.length === 0 ? <Text dimColor>none observed</Text> : snapshot.evidence.map((item) => (
          <Text key={item.id} dimColor={item.freshness === "stale"}>
            {item.subject}: {item.result} / {item.freshness} / {item.authority}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>HISTORY</Text>
        {snapshot.history.length === 0 ? <Text dimColor>no transitions</Text> : snapshot.history.slice(-5).map((item, index) => (
          <Text key={`${item.taskId}-${index}`} dimColor>{item.taskId}: {item.from} -&gt; {item.to}</Text>
        ))}
      </Box>
      {message.length > 0 ? <Box marginTop={1}><Text>{message}</Text></Box> : null}
    </Box>
  );
}

function formatSessionEvent(event: CodingSessionEvent): string {
  if (event.type === "assistant") return `assistant: ${event.text}`;
  if (event.type === "status") return event.status;
  if (event.type === "tool-proposal") return `proposed ${event.tool}${event.subjects.length > 0 ? ` ${event.subjects.join(", ")}` : ""}`;
  if (event.type === "tool-outcome") return `${event.tool} ${event.outcome}${event.detail === undefined ? "" : `: ${event.detail}`}`;
  if (event.type === "completed") return `completed: ${event.result}`;
  return `failed: ${event.reason}`;
}
