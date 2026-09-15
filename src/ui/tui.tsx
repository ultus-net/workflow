import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { CodingSessionEvent, CodingSessionState } from "../application/coding-session.js";
import { formatStyleStatus, nextBuildStyle, nextSpeechStyle, resolveStyleFromEnv, type SessionStyle } from "../integrations/response-style.js";
import type { ReviewFollowUp } from "../integrations/review-followups.js";
import type { HubGateObservability } from "../cli/hub-snapshot.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowSnapshot } from "../application/workflow.js";
import type { TaskState } from "../kernel/contracts.js";
import {
  PEDAGOGICAL_MODES,
  type DecisionBrief,
  type DiagnosticLesson,
  type LearnerProfile,
  type LearningOpportunity,
  type PedagogicalMode,
} from "../pedagogy/contracts.js";
import { loadLearnerProfile } from "../pedagogy/learner-profile.js";

export const MODE_LABELS: Record<PedagogicalMode, string> = {
  "learn-to-code": "Learn to Code",
  "socratic-tutor": "Socratic Tutor",
  "co-architect": "Co-Architect",
  "walkthrough": "Walkthrough",
  "autonomous": "Autonomous",
};

export function nextPedagogicalMode(mode: PedagogicalMode): PedagogicalMode {
  const index = PEDAGOGICAL_MODES.indexOf(mode);
  return PEDAGOGICAL_MODES[(index + 1) % PEDAGOGICAL_MODES.length] ?? "autonomous";
}

interface TranscriptEntry {
  readonly label: string;
  readonly text: string;
  readonly dim?: boolean;
}

export function nextInteractiveState(state: TaskState): TaskState | undefined {
  if (state === "READY") return "IN_PROGRESS";
  if (state === "IN_PROGRESS") return "VERIFYING";
  if (state === "VERIFYING") return "VERIFIED";
  return undefined;
}

/** Narrow seam: the TUI only projects snapshots; it never owns canonical state. */
export interface WorkflowSnapshotSource {
  snapshot(): WorkflowSnapshot;
}

export interface SessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly type: "select" | "boolean";
  readonly currentValue: string | boolean;
  readonly options?: readonly { readonly value: string; readonly name: string }[];
}

export function WorkflowTui({
  application,
  session,
  sessionConfigOptions,
  onSetSessionConfig,
  profile,
  profilePath,
  onInspectSymbol,
  style: initialStyle,
  onStyleChange,
  onModeChange,
  reviewFollowUps,
  gateObservability,
  usage,
  connectionLabel,
  assistantLabel = "Cline",
}: {
  readonly application: WorkflowSnapshotSource;
  readonly session?: WorkflowCodingSession;
  readonly sessionConfigOptions?: () => readonly SessionConfigOption[];
  readonly onSetSessionConfig?: (id: string, value: string | boolean) => Promise<void> | void;
  readonly profile?: LearnerProfile;
  readonly profilePath?: string;
  readonly onInspectSymbol?: (symbol: string) => void;
  readonly style?: SessionStyle;
  readonly onStyleChange?: (style: SessionStyle) => void;
  readonly onModeChange?: (mode: PedagogicalMode) => void;
  readonly reviewFollowUps?: readonly ReviewFollowUp[];
  readonly gateObservability?: () => HubGateObservability | undefined;
  /** Web-parity usage meter (Batch 2): a live "tokens · cost" footer line. */
  readonly usage?: () => string | undefined;
  readonly connectionLabel?: string;
  readonly assistantLabel?: string;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(() => application.snapshot());
  const [gates, setGates] = useState<HubGateObservability | undefined>(() => gateObservability?.());
  const [usageLine, setUsageLine] = useState<string | undefined>(() => usage?.());
  const [prompt, setPrompt] = useState("");
  // Web-parity prompt history recall (Tier 2): submitted prompts are
  // recalled with Ctrl+Up (older) / Ctrl+Down (newer); the live draft is
  // preserved when navigating away and restored when returning.
  const [promptHistory, setPromptHistory] = useState<readonly string[]>([]);
  const historyIndex = useRef<number | undefined>(undefined);
  const savedDraft = useRef<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // Mirror of the prompt for synchronous reads in the input handler: fast
  // keypresses can arrive before React flushes a render, and reading state
  // directly would lose fast submissions (a ref never goes stale in useInput).
  const promptRef = useRef("");
  const updatePrompt = (update: string | ((value: string) => string)) => {
    setPrompt((value) => {
      const next = typeof update === "function" ? update(value) : update;
      promptRef.current = next;
      return next;
    });
  };
  const [sessionState, setSessionState] = useState(() => session?.snapshot());
  const [, setConfigRevision] = useState(0);
  const activeSession = session;
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  // Web-parity completion notification (Tier 2): a terminal bell on turn
  // completion. Routed through Ink's stdout (not process.stdout) so it never
  // pollutes non-TTY capture, and only fires on the transition INTO
  // completed — an already-completed snapshot on mount stays silent.
  const previousSessionState = useRef(sessionState?.state);
  useEffect(() => {
    const previous = previousSessionState.current;
    previousSessionState.current = sessionState?.state;
    if (sessionState?.state === "completed" && previous !== "completed") {
      stdout.write("\u0007");
    }
  }, [sessionState?.state, stdout]);
  useEffect(() => {
    if (usage === undefined) return;
    const timer = setInterval(() => setUsageLine(usage()), 1_000);
    return () => clearInterval(timer);
  }, [usage]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [mode, setMode] = useState<PedagogicalMode>("autonomous");
  const [style, setStyle] = useState<SessionStyle>(() => initialStyle ?? resolveStyleFromEnv(process.env));
  const [showProfile, setShowProfile] = useState(false);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | undefined>(profile);
  const [showHint, setShowHint] = useState(false);
  const [inspectQuery, setInspectQuery] = useState("");
  const [decisionBrief, setDecisionBrief] = useState<DecisionBrief | undefined>();
  const [checkpoint, setCheckpoint] = useState<LearningOpportunity | undefined>();
  const [lesson, setLesson] = useState<DiagnosticLesson | undefined>();
  const [pendingTools, setPendingTools] = useState<readonly string[]>([]);
  const [recentLogs, setRecentLogs] = useState<readonly SessionLog[]>([]);

  // Install the initial mode's gate on mount so the mode bar never shows a
  // label with no corresponding application behavior.
  useEffect(() => {
    onModeChange?.(mode);
    // Mount-only: subsequent changes are notified when the menu changes mode.
  }, []);

  useEffect(() => {
    if (activeSession !== undefined) return;
    const timer = setInterval(() => {
      setSnapshot(application.snapshot());
      if (gateObservability !== undefined) setGates(gateObservability());
    }, 1_000);
    return () => clearInterval(timer);
  }, [application, activeSession]);

  useEffect(() => activeSession?.subscribe((event) => {
    if (event.type === "decision-brief") setDecisionBrief(event.brief);
    if (event.type === "tutor-checkpoint") setCheckpoint(event.opportunity);
    if (event.type === "diagnostic-lesson") setLesson(event.lesson);
    if (event.type === "tool-proposal") {
      setPendingTools((current) => [...current, event.tool]);
    }
    if (event.type === "tool-outcome") {
      setPendingTools((current) => current.filter((tool) => tool !== event.tool));
    }
    if (event.type === "log") {
      setRecentLogs((current) => [...current, event].slice(-3));
    }
    setTranscript((current) => [...current, formatSessionEvent(event, assistantLabel)]);
    setScrollOffset(0);
    setSessionState(activeSession.snapshot());
    setSnapshot(application.snapshot());
  }), [application, activeSession]);

  // Option actions shared by the Workflow menu and direct shortcuts.
  const cycleMode = (): void => {
    setMode((value) => {
      const next = nextPedagogicalMode(value);
      onModeChange?.(next);
      return next;
    });
  };
  const toggleProfile = (): void => {
    setShowProfile((value) => {
      if (!value) setLearnerProfile(profile ?? loadLearnerProfile(profilePath));
      return !value;
    });
  };
  const cycleSpeech = (): void => {
    setStyle((current) => {
      const next = { ...current, speech: nextSpeechStyle(current.speech) };
      onStyleChange?.(next);
      return next;
    });
  };
  const cycleBuild = (): void => {
    setStyle((current) => {
      const next = { ...current, build: nextBuildStyle(current.build) };
      onStyleChange?.(next);
      return next;
    });
  };
  const openInspect = (): void => setShowHint(true);
  const toggleWorkflow = (): void => setShowWorkflow((value) => !value);
  const agentConfigOptions = (sessionConfigOptions?.() ?? []).filter(isInteractiveConfigOption);
  const cycleSessionConfig = (option: SessionConfigOption): void => {
    if (onSetSessionConfig === undefined) return;
    const next = nextConfigValue(option);
    if (next === undefined) return;
    void Promise.resolve(onSetSessionConfig(option.id, next))
      .then(() => setConfigRevision((value) => value + 1))
      .catch((error: unknown) => {
        setTranscript((current) => [...current, { label: "[failed]", text: error instanceof Error ? error.message : String(error) }]);
      });
  };

  const menuItems = [
    { label: `Mode: ${MODE_LABELS[mode]}`, run: cycleMode },
    { label: `Speech: ${style.speech}`, run: cycleSpeech },
    { label: `Build: ${style.build}`, run: cycleBuild },
    { label: "Learner profile", run: toggleProfile },
    { label: "Inspect symbol", run: openInspect },
    { label: "Workflow details", run: toggleWorkflow },
    ...agentConfigOptions.map((option) => ({
      label: `${option.name}: ${configValueLabel(option)}`,
      run: () => cycleSessionConfig(option),
    })),
  ] as const;

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (sessionState?.state === "running" && activeSession !== undefined) {
        void activeSession.cancel().finally(() => setSessionState(activeSession.snapshot()));
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "w") {
      toggleWorkflow();
      return;
    }
    if (key.ctrl && input === "p") {
      setMenuOpen(true);
      setMenuIndex(0);
      return;
    }
    if (menuOpen) {
      if (key.escape || (input === "" && !key.ctrl && !key.meta) || input === "q") {
        setMenuOpen(false);
        return;
      }
      if (key.upArrow) {
        setMenuIndex((value) => Math.max(0, value - 1));
        return;
      }
      if (key.downArrow) {
        setMenuIndex((value) => Math.min(menuItems.length - 1, value + 1));
        return;
      }
      const digit = Number.parseInt(input, 10);
      if (digit >= 1 && digit <= menuItems.length) {
        menuItems[digit - 1]!.run();
        setMenuOpen(false);
        return;
      }
      if (key.return) {
        menuItems[menuIndex]!.run();
        setMenuOpen(false);
        return;
      }
      return;
    }
    if (showHint) {
      if (key.escape || input === "?") {
        setShowHint(false);
        setInspectQuery("");
        return;
      }
      if (key.return) {
        const symbol = inspectQuery.trim();
        if (symbol.length > 0) onInspectSymbol?.(symbol);
        setInspectQuery("");
        return;
      }
      if (key.backspace || key.delete) {
        setInspectQuery((value) => value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) setInspectQuery((value) => value + input);
      return;
    }
    if (prompt.length === 0 && !key.ctrl && !key.meta) {
      if (input === "/") {
        setMenuOpen(true);
        setMenuIndex(0);
        return;
      }
    }
    if (key.pageUp) {
      setScrollOffset((value) => Math.min(transcript.length, value + 5));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((value) => Math.max(0, value - 5));
      return;
    }
    if (key.ctrl && key.upArrow) {
      // Prompt history: navigate toward older submitted prompts.
      if (promptHistory.length === 0) return;
      if (historyIndex.current === undefined) {
        savedDraft.current = promptRef.current;
        historyIndex.current = promptHistory.length - 1;
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1);
      }
      updatePrompt(promptHistory[historyIndex.current] ?? "");
      return;
    }
    if (key.ctrl && key.downArrow) {
      // Prompt history: navigate back toward the live draft.
      if (historyIndex.current === undefined) return;
      if (historyIndex.current >= promptHistory.length - 1) {
        historyIndex.current = undefined;
        updatePrompt(savedDraft.current ?? "");
        savedDraft.current = undefined;
        return;
      }
      historyIndex.current += 1;
      updatePrompt(promptHistory[historyIndex.current] ?? "");
      return;
    }
    if (key.ctrl && input === "e") {
      // Web-parity markdown export (Tier 2): Ctrl+E writes the transcript to
      // a markdown file next to the session (operator action — this is the
      // operator's own process writing, not an agent mutation).
      if (transcript.length === 0) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const exportPath = resolve(process.cwd(), `workflow-transcript-${stamp}.md`);
      const markdown = [
        `# Workflow transcript`,
        ``,
        `_Exported ${new Date().toISOString()} · ${connectionLabel ?? "local"}_`,
        ``,
        ...transcript.map((entry) => `**${entry.label}**: ${entry.text}`),
        ``,
      ].join("\n");
      writeFileSync(exportPath, markdown, "utf8");
      setTranscript((current) => [...current, { label: "[exported]", text: exportPath, dim: true }]);
      return;
    }
    if (activeSession === undefined) return;
    if (sessionState?.state === "running") {
      // Web-parity message queue (Tier 2): typing and submitting while a turn
      // runs queues the prompt — the session submits it in order when the
      // current turn ends.
      if (key.return) {
        const submitted = promptRef.current.trim();
        if (submitted.length === 0) return;
        setTranscript((current) => [...current, { label: "You (queued)", text: submitted, dim: true }]);
        updatePrompt("");
        void activeSession.submit(submitted);
        return;
      }
      if (key.backspace || key.delete) {
        updatePrompt((value) => value.slice(0, -1));
        return;
      }
      if (key.escape) {
        updatePrompt("");
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) updatePrompt((value) => value + input);
      return;
    }
    if (key.escape) {
      updatePrompt("");
      historyIndex.current = undefined;
      savedDraft.current = undefined;
      return;
    }
    if (key.return) {
      const submitted = promptRef.current.trim();
      if (submitted.length === 0) return;
      setTranscript((current) => [...current, { label: "You", text: submitted }]);
      setPromptHistory((current) => [...current, submitted].slice(-50));
      historyIndex.current = undefined;
      savedDraft.current = undefined;
      updatePrompt("");
      setScrollOffset(0);
      setSessionState({ state: "running" });
      void activeSession.submit(submitted).finally(() => {
        setSessionState(activeSession.snapshot());
        setSnapshot(application.snapshot());
      });
      return;
    }
    if (key.backspace || key.delete) {
      updatePrompt((value) => value.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) updatePrompt((value) => value + input);
  });

  const openReviewFollowUps = (reviewFollowUps ?? []).some((item) => item.status === "open");
  const transcriptRows = Math.max(4, (stdout.rows ?? 24) - (showWorkflow ? 16 : 10) - panelRows(snapshot, activeSession));
  const end = Math.max(0, transcript.length - scrollOffset);
  const visibleTranscript = transcript.slice(Math.max(0, end - transcriptRows), end);
  const taskSummary = summarizeTasks(snapshot);

  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="column" width="100%" maxWidth={68} paddingX={1}>
        <Box justifyContent="space-between">
          <Text dimColor>[Mode: {MODE_LABELS[mode]}]{formatStyleStatus(style).length > 0 ? ` [${formatStyleStatus(style)}]` : ""}{connectionLabel !== undefined ? ` [${connectionLabel}]` : ""}{usageLine !== undefined ? ` [${usageLine}]` : ""}</Text>
          <Text dimColor>^P menu</Text>
        </Box>
        {prompt.length === 0 && !menuOpen ? (
          <Text dimColor>keys: / menu · ^W state</Text>
        ) : null}
        {menuOpen ? (
          <Box marginTop={0} flexDirection="column">
            <Text bold>Workflow options</Text>
            {menuItems.map((item, index) => {
              const active = index === menuIndex;
              return (
                <Text key={item.label} dimColor={!active}>
                  {active ? ">" : " "}{index + 1} {item.label}
                </Text>
              );
            })}
            <Text dimColor>1-{menuItems.length} or ↑↓ Enter · q/Esc closes · ^W state</Text>
          </Box>
        ) : null}
        {decisionBrief !== undefined ? <DecisionBriefDrawer brief={decisionBrief} /> : null}
        {checkpoint !== undefined ? <CheckpointDrawer opportunity={checkpoint} /> : null}
        {lesson !== undefined ? <DiagnosticLessonDrawer lesson={lesson} /> : null}
        {showProfile && learnerProfile !== undefined ? <ProfilePanel profile={learnerProfile} /> : null}
        {showHint ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Symbol Inspect</Text>
            <Text dimColor>Type a symbol name and press Enter{inspectQuery.length > 0 ? `: ${inspectQuery}` : ""}</Text>
          </Box>
        ) : null}
        <TaskListPanel snapshot={snapshot} />
        {(activeSession !== undefined || openReviewFollowUps || gates !== undefined) ? (
          <SessionActivityPanel state={sessionState} pendingTools={pendingTools} recentLogs={recentLogs} {...(reviewFollowUps === undefined ? {} : { reviewFollowUps })} {...(gates === undefined ? {} : { gateObservability: gates })} />
        ) : null}
        <Box flexDirection="column" minHeight={4}>
        {transcript.length === 0 ? (
          <Box flexDirection="column" alignItems="center">
            <Box>
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

        {activeSession !== undefined ? (
          <Box marginTop={1} flexDirection="column">
          <Text dimColor>----------------------------------------------------------------</Text>
          {sessionState?.state === "running" ? (
            <Text><Text bold>[running]</Text> {assistantLabel} is working. Ctrl+C cancel</Text>
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

type SessionLog = Extract<CodingSessionEvent, { readonly type: "log" }>;

const TASK_PANEL_MAX_ROWS = 6;

/** Estimate of rows the monitoring panels occupy, used to bound the transcript. */
function panelRows(snapshot: WorkflowSnapshot, session: WorkflowCodingSession | undefined): number {
  const taskRows = snapshot.tasks.length === 0 ? 4 : 3 + Math.min(snapshot.tasks.length, TASK_PANEL_MAX_ROWS) + (snapshot.tasks.length > TASK_PANEL_MAX_ROWS ? 1 : 0);
  const activityRows = session === undefined ? 0 : 4;
  return taskRows + activityRows;
}

function TaskListPanel({ snapshot }: { readonly snapshot: WorkflowSnapshot }) {
  const total = snapshot.tasks.length;
  const verified = snapshot.tasks.filter((task) => task.state === "VERIFIED").length;
  const visible = snapshot.tasks.slice(0, TASK_PANEL_MAX_ROWS);
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Tasks <Text dimColor>{verified}/{total} verified</Text></Text>
      {total === 0 ? <Text dimColor>No workflow tasks.</Text> : visible.map((task) => (
        <Text key={task.id} dimColor={task.state === "BLOCKED" || task.state === "VERIFIED"}>
          {task.id.padEnd(8)} {task.state.padEnd(11)} {task.title}
        </Text>
      ))}
      {total > TASK_PANEL_MAX_ROWS ? <Text dimColor>… {total - TASK_PANEL_MAX_ROWS} more (Ctrl+W for details)</Text> : null}
    </Box>
  );
}

function SessionActivityPanel({
  state,
  pendingTools,
  recentLogs,
  reviewFollowUps,
  gateObservability,
}: {
  readonly state: CodingSessionState | undefined;
  readonly pendingTools: readonly string[];
  readonly recentLogs: readonly SessionLog[];
  readonly reviewFollowUps?: readonly ReviewFollowUp[];
  readonly gateObservability?: HubGateObservability;
}) {
  const openFollowUps = (reviewFollowUps ?? []).filter((item) => item.status === "open");
  // Plan Task A3: run-gate observability — latest verdicts, blocking reasons,
  // and claims the kernel had not verified (Policy-24 mismatch port).
  const blockedRuns = Object.entries(gateObservability?.blockingReasons ?? {});
  const verdicts = Object.entries(gateObservability?.reviewOutcomes ?? {});
  const unverifiedClaims = Object.entries(gateObservability?.completionClaims ?? [])
    .filter(([, claim]) => claim.verifiedAtClaim === false);
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Activity <Text dimColor>{state?.state ?? "idle"}</Text></Text>
      {pendingTools.length > 0 ? <Text bold>  in flight: {pendingTools.join(", ")}</Text> : null}
      {recentLogs.map((log, index) => (
        <Text key={index} dimColor={log.level === "debug"}>
          {`  [${log.level}] ${log.source === undefined ? "" : `${log.source}: `}${log.message}`}
        </Text>
      ))}
      {openFollowUps.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>  review follow-ups ({openFollowUps.length} open)</Text>
          {openFollowUps.slice(0, 3).map((item) => (
            <Text key={item.id} dimColor>    [{item.severity}] {item.summary}</Text>
          ))}
        </Box>
      ) : null}
      {blockedRuns.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>  blocked runs ({blockedRuns.length})</Text>
          {blockedRuns.slice(0, 3).map(([runId, reason]) => (
            <Text key={runId} bold>    [blocked] {shortRun(runId)}: {reason.slice(0, 120)}</Text>
          ))}
        </Box>
      ) : null}
      {verdicts.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>  review verdicts ({verdicts.length})</Text>
          {verdicts.slice(0, 3).map(([runId, outcome]) => (
            <Text key={runId} dimColor={outcome.recorded}>    {shortRun(runId)}: {outcome.verdict}{outcome.parseFailure === undefined ? "" : ` (parse: ${outcome.parseFailure.slice(0, 60)})`}</Text>
          ))}
        </Box>
      ) : null}
      {unverifiedClaims.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>  unverified completion claims ({unverifiedClaims.length})</Text>
          {unverifiedClaims.slice(0, 3).map(([runId, claim]) => (
            <Text key={runId} bold>    [unverified claim] {shortRun(runId)}: {claim.claim.slice(0, 90)}</Text>
          ))}
        </Box>
      ) : null}
      {pendingTools.length === 0 && recentLogs.length === 0 && openFollowUps.length === 0 && blockedRuns.length === 0 && verdicts.length === 0 && unverifiedClaims.length === 0 ? <Text dimColor>No live activity.</Text> : null}
    </Box>
  );
}

function shortRun(runId: string): string {
  const prefix = "schedule:hub-reviewer-";
  return runId.startsWith(prefix) ? runId.slice(prefix.length, prefix.length + 8) : runId.slice(0, 28);
}

function DecisionBriefDrawer({ brief }: { readonly brief: DecisionBrief }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Decision Brief: {brief.title}</Text>
      <Text dimColor>{brief.context}</Text>
      <Text>  chosen: {brief.chosenOption.name} ({brief.chosenOption.blastRadius} blast radius)</Text>
      <Text dimColor>  {brief.chosenOption.rationale}</Text>
      {brief.rejectedAlternatives.map((alt) => (
        <Text key={alt.name} dimColor>  rejected: {alt.name} — {alt.drawback}</Text>
      ))}
      <Text dimColor>  + {brief.tradeoffs.benefits.join(", ")} | - {brief.tradeoffs.liabilities.join(", ")}</Text>
    </Box>
  );
}

function CheckpointDrawer({ opportunity }: { readonly opportunity: LearningOpportunity }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Socratic Question: {opportunity.concept}</Text>
      <Text dimColor>{opportunity.teachableInsight}</Text>
      <Text>{opportunity.socraticQuestion}</Text>
      {(opportunity.candidateAnswers ?? []).map((answer) => (
        <Text key={answer.label} dimColor>  {answer.label}: {answer.description}</Text>
      ))}
    </Box>
  );
}

function DiagnosticLessonDrawer({ lesson }: { readonly lesson: DiagnosticLesson }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Lesson TS{lesson.code}: {lesson.file}:{lesson.line}:{lesson.column}</Text>
      <Text>{lesson.plainEnglishExplanation}</Text>
      {lesson.guidingHints.map((hint) => (
        <Text key={hint} dimColor>  hint: {hint}</Text>
      ))}
    </Box>
  );
}

function ProfilePanel({ profile }: { readonly profile: LearnerProfile }) {
  const concepts = Object.entries(profile.concepts);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Learner Profile</Text>
      {concepts.length === 0 ? (
        <Text dimColor>No concepts observed yet.</Text>
      ) : concepts.map(([name, concept]) => (
        <Text key={name}>{name.padEnd(20)} {concept.stage}</Text>
      ))}
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

function isInteractiveConfigOption(value: unknown): value is SessionConfigOption {
  if (typeof value !== "object" || value === null) return false;
  const option = value as Partial<SessionConfigOption>;
  if (typeof option.id !== "string" || typeof option.name !== "string") return false;
  if (option.type === "boolean") return typeof option.currentValue === "boolean";
  return option.type === "select"
    && typeof option.currentValue === "string"
    && Array.isArray(option.options)
    && option.options.every((entry) => typeof entry === "object" && entry !== null
      && typeof entry.value === "string" && typeof entry.name === "string");
}

function nextConfigValue(option: SessionConfigOption): string | boolean | undefined {
  if (option.type === "boolean") return !option.currentValue;
  const values = option.options ?? [];
  if (values.length === 0) return undefined;
  const current = values.findIndex((entry) => entry.value === option.currentValue);
  return values[(current + 1) % values.length]?.value;
}

function configValueLabel(option: SessionConfigOption): string {
  if (option.type === "boolean") return option.currentValue ? "On" : "Off";
  return option.options?.find((entry) => entry.value === option.currentValue)?.name ?? String(option.currentValue);
}

function formatSessionEvent(event: CodingSessionEvent, assistantLabel: string): TranscriptEntry {
  if (event.type === "user") return { label: "You", text: event.text };
  if (event.type === "assistant") return { label: assistantLabel, text: event.text };
  if (event.type === "status") return { label: "[status]", text: event.status, dim: true };
  if (event.type === "tool-proposal") {
    return { label: "[tool]", text: `${event.tool}${event.subjects.length > 0 ? ` ${event.subjects.join(", ")}` : ""}`, dim: true };
  }
  if (event.type === "tool-outcome") {
    const marker = event.outcome === "succeeded" ? "[ok]" : `[${event.outcome}]`;
    return { label: marker, text: `${event.tool}${event.detail === undefined ? "" : `: ${event.detail}`}`, dim: event.outcome === "succeeded" };
  }
  if (event.type === "decision-brief") {
    return { label: "[brief]", text: event.brief.title, dim: true };
  }
  if (event.type === "tutor-checkpoint") {
    return { label: "[tutor]", text: event.opportunity.socraticQuestion };
  }
  if (event.type === "diagnostic-lesson") {
    return { label: "[lesson]", text: `TS${event.lesson.code}: ${event.lesson.plainEnglishExplanation}` };
  }
  if (event.type === "log") {
    if (event.source === "agent-thought") {
      // Web-parity thinking blocks: agent reasoning interleaved in the
      // transcript, dimmed like the web default-collapsed rows expanded.
      return { label: "[thinking]", text: event.message, dim: true };
    }
    const source = event.source === undefined ? "" : `${event.source}: `;
    return { label: `[${event.level}]`, text: `${source}${event.message}`, dim: event.level === "debug" };
  }
  if (event.type === "completed") return { label: "completed", text: event.result };
  return { label: "failed", text: event.reason };
}
