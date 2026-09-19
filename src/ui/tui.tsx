import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { CodingSessionEvent, CodingSessionState } from "../application/coding-session.js";
import type { ReviewFollowUp } from "../integrations/review-followups.js";
import type { HubGateObservability } from "../cli/hub-snapshot.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { TaskCommandPort } from "../application/task-commands.js";
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
import { UsageTurnTracker, formatUsageLine, type UsageSource } from "./usage.js";

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

// Terminal theme (decision 2026-09-16, operator-approved): accents pull the
// terminal's own palette. Ink routes named colors straight to chalk's basic-16
// ANSI slots (\e[36m etc.), which the user's terminal theme remaps — so a
// Nord/Catppuccin/Solarized terminal shows *its* cyan, not a hardcoded RGB.
// Hex/rgb/ansi256 values are forbidden (they would override the theme), the
// allowlist of slot names is pinned by test/tui.test.ts, and NO_COLOR
// degrades automatically because chalk drops to level 0.
const ACCENT_INTERACTIVE = "cyan";
const ACCENT_SUCCESS = "green";
const ACCENT_WARNING = "yellow";
const ACCENT_FAILURE = "red";
const ACCENT_FRAME = "gray";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

const TASK_GLYPHS: Record<TaskState, string> = {
  READY: "○",
  IN_PROGRESS: "◐",
  VERIFYING: "◑",
  VERIFIED: "✓",
  FAILED: "✗",
  BLOCKED: "⊘",
};

interface TranscriptEntry {
  readonly label: string;
  readonly text: string;
  readonly dim?: boolean;
  /** Wall-clock arrival time of the projected event (display/export only). */
  readonly at?: string;
}

function clock(date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}

/** Theme-slot accent for a transcript marker label; undefined keeps the terminal foreground. */
function entryAccent(label: string): string | undefined {
  if (label === "[ok]" || label === "completed") return ACCENT_SUCCESS;
  if (label === "[failed]" || label === "failed" || label === "[error]") return ACCENT_FAILURE;
  if (label === "[warning]") return ACCENT_WARNING;
  if (label === "[tool]" || label === "[tutor]" || label === "[lesson]" || label === "[brief]") return ACCENT_INTERACTIVE;
  return undefined;
}

function sessionStateAccent(state: string | undefined): string | undefined {
  if (state === "running") return ACCENT_INTERACTIVE;
  if (state === "completed") return ACCENT_SUCCESS;
  if (state === "cancelled" || state === "failed") return ACCENT_FAILURE;
  return undefined;
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
  onModeChange,
  reviewFollowUps,
  gateObservability,
  usage,
  connectionLabel,
  composerBackground,
  assistantLabel = "Cline",
  taskCommands,
}: {
  readonly application: WorkflowSnapshotSource;
  readonly session?: WorkflowCodingSession;
  readonly sessionConfigOptions?: () => readonly SessionConfigOption[];
  readonly onSetSessionConfig?: (id: string, value: string | boolean) => Promise<void> | void;
  readonly profile?: LearnerProfile;
  readonly profilePath?: string;
  readonly onInspectSymbol?: (symbol: string) => void;
  readonly onModeChange?: (mode: PedagogicalMode) => void;
  readonly reviewFollowUps?: readonly ReviewFollowUp[];
  readonly gateObservability?: () => HubGateObservability | undefined;
  /**
   * W044 (G1 metric surfacing): live cumulative + per-turn usage from the
   * metering proxy's records, rendered in the header status line. The
   * per-turn delta is computed here at turn boundaries (UsageTurnTracker).
   */
  readonly usage?: UsageSource;
  readonly connectionLabel?: string;
  /**
   * Terminal-derived composer tint (OSC 11 background detection, see
   * src/ui/terminal-theme.ts). Present → the composer renders as the "block"
   * input style over the user's own terminal background; absent → the
   * bordered fallback that works on any terminal.
   */
  readonly composerBackground?: string;
  readonly assistantLabel?: string;
  /**
   * W046 (open clause): the task-command port, composed by the SURFACE that
   * owns canonical state (acp-tui passes createTaskCommandPort(application)).
   * Present → the Ctrl+T task palette can create/activate/retry canonical
   * tasks through application commands; absent → the palette renders
   * read-only. The TUI itself still never owns canonical state — it only
   * forwards operator intents through the port.
   */
  readonly taskCommands?: TaskCommandPort;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(() => application.snapshot());
  const [gates, setGates] = useState<HubGateObservability | undefined>(() => gateObservability?.());
  const usageTracker = useRef(new UsageTurnTracker());
  const [usageLine, setUsageLine] = useState<string | undefined>(() => {
    const view = usage?.();
    return view === undefined ? undefined : formatUsageLine(view);
  });
  const [prompt, setPrompt] = useState("");
  // Web-parity prompt history recall (Tier 2): submitted prompts are
  // recalled with Ctrl+Up (older) / Ctrl+Down (newer); the live draft is
  // preserved when navigating away and restored when returning.
  const [promptHistory, setPromptHistory] = useState<readonly string[]>([]);
  const historyIndex = useRef<number | undefined>(undefined);
  const savedDraft = useRef<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // W046 (open clause): the Ctrl+T task palette — create/activate/retry
  // canonical tasks through the taskCommands port. "list" browses and
  // mutates; "create" captures a title. The title mirrors into a ref for
  // the same fast-typing reason as the composer (promptRef above), and the
  // cursor index is clamped at render so snapshot changes can never point
  // outside the task list.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"list" | "create">("list");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteIndexRef = useRef(0);
  const [paletteTitle, setPaletteTitle] = useState("");
  const paletteTitleRef = useRef("");
  // The mode mirrors into a ref for the same reason as promptRef: keys
  // typed immediately after a mode switch (↵ create → arrows) can arrive
  // before React flushes, and a stale closure would consume them under the
  // previous mode. The ref is the synchronous source of truth.
  const paletteModeRef = useRef<"list" | "create">("list");
  const setPaletteModeSynced = (mode: "list" | "create"): void => {
    paletteModeRef.current = mode;
    setPaletteMode(mode);
  };
  const [paletteMessage, setPaletteMessage] = useState<{ readonly text: string; readonly error?: boolean } | undefined>();
  // Mirror of the prompt for synchronous reads in the input handler: fast
  // keypresses can arrive before React flushes a render, and reading state
  // directly would lose fast submissions (a ref never goes stale in useInput).
  const promptRef = useRef("");
  const updatePrompt = (update: string | ((value: string) => string)) => {
    // The ref is the synchronous source of truth: batched stdin can deliver
    // several keys (typing + Enter) before React flushes, so the ref must
    // update OUTSIDE the state updater — setting it inside ran only at render
    // time and dropped fast submissions.
    const next = typeof update === "function" ? update(promptRef.current) : update;
    promptRef.current = next;
    setPrompt(next);
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
    const refresh = () => {
      const view = usageTracker.current.observe(sessionState?.state, usage());
      setUsageLine(view === undefined ? undefined : formatUsageLine(view));
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => clearInterval(timer);
  }, [usage, sessionState?.state]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [mode, setMode] = useState<PedagogicalMode>("autonomous");
  const [showProfile, setShowProfile] = useState(false);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | undefined>(profile);
  const [showHint, setShowHint] = useState(false);
  const [inspectQuery, setInspectQuery] = useState("");
  const [decisionBrief, setDecisionBrief] = useState<DecisionBrief | undefined>();
  const [checkpoint, setCheckpoint] = useState<LearningOpportunity | undefined>();
  const [lesson, setLesson] = useState<DiagnosticLesson | undefined>();
  const [pendingTools, setPendingTools] = useState<readonly string[]>([]);
  const [recentLogs, setRecentLogs] = useState<readonly SessionLog[]>([]);
  // Working-turn indicator: a braille spinner plus elapsed seconds while the
  // session runs. The frame index lives in state; the turn start lives in a
  // ref so re-entering "running" restarts the clock without stale closures.
  const running = sessionState?.state === "running";
  const [spinTick, setSpinTick] = useState(0);
  const turnStartedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!running) {
      turnStartedRef.current = undefined;
      return;
    }
    turnStartedRef.current = Date.now();
    const timer = setInterval(() => setSpinTick((tick) => tick + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running]);
  const spinner = SPINNER_FRAMES[spinTick % SPINNER_FRAMES.length]!;
  const elapsedSeconds = turnStartedRef.current === undefined
    ? 0
    : Math.floor((Date.now() - turnStartedRef.current) / 1_000);

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
    if (event.type === "tool") {
      setPendingTools((current) =>
        event.status === "pending" || event.status === "in_progress"
          ? [...current, event.title]
          : current.filter((tool) => tool !== event.title));
    }
    if (event.type === "log") {
      setRecentLogs((current) => [...current, event].slice(-3));
    }
    if (event.type === "thought") {
      const entry: SessionLog = { type: "log", level: "info", message: event.text, source: "agent-thought" };
      setRecentLogs((current) => [...current, entry].slice(-3));
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
        setTranscript((current) => [...current, { label: "[failed]", text: error instanceof Error ? error.message : String(error), at: clock() }]);
      });
  };

  // Menu items carry their close behavior: cycle-type options keep the menu
  // open so the operator can toggle through values in place; options that
  // need the keyboard (symbol inspect) close it.
  const menuItems = [
    { label: `Mode: ${MODE_LABELS[mode]}`, run: cycleMode, closes: false },
    { label: "Learner profile", run: toggleProfile, closes: false },
    { label: "Inspect symbol", run: openInspect, closes: true },
    { label: "Workflow details", run: toggleWorkflow, closes: false },
    ...agentConfigOptions.map((option) => ({
      label: `${option.name}: ${configValueLabel(option)}`,
      run: () => cycleSessionConfig(option),
      closes: false,
    })),
  ] as const;

  useInput((input, key) => {
    // Drop late OSC 11 responses: the terminal may answer the background
    // query (sent by src/ui/terminal-theme.ts before render) after the
    // fail-soft window closed, and Ink's input parser has no OSC handling —
    // unfiltered, the response payload would land in the composer as text.
    if (input.includes("]11;rgb:")) return;
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
    if (key.ctrl && input === "t") {
      // W046: the task palette. Opening resets the cursor to the top and
      // clears any stale message; closing (Esc/q inside) keeps the list.
      // Ctrl+T also closes an open Ctrl+P menu (review P3: both overlays
      // must never stay open at once) and clears a half-typed create title.
      setMenuOpen(false);
      setPaletteOpen((open) => !open);
      setPaletteModeSynced("list");
      paletteTitleRef.current = "";
      setPaletteTitle("");
      paletteIndexRef.current = 0;
      setPaletteIndex(0);
      setPaletteMessage(undefined);
      return;
    }
    if (menuOpen) {
      if (key.escape || input === "q") {
        setMenuOpen(false);
        return;
      }
      // Arrows must be handled before any empty-input check: Ink delivers
      // arrow keys with an empty input string, and the previous ordering
      // closed the menu on the first ↑/↓ instead of moving the cursor.
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
        const item = menuItems[digit - 1]!;
        item.run();
        // Cycle-type options keep the menu open so values can be toggled in
        // place; only options that capture the keyboard close it.
        if (item.closes) setMenuOpen(false);
        return;
      }
      if (key.return) {
        const item = menuItems[menuIndex]!;
        item.run();
        if (item.closes) setMenuOpen(false);
        return;
      }
      return;
    }
    if (paletteOpen) {
      // Fresh canonical read, not the React closure: fast keys (create →
      // arrows → activate in one burst) arrive before the re-render, and a
      // stale tasks list would clamp the cursor against the old count and
      // mis-target the activation. The handler reads the application
      // directly; the render still uses the React snapshot.
      const tasks = application.snapshot().tasks;
      const clamp = (value: number): number => Math.max(0, Math.min(tasks.length - 1, value));
      if (paletteModeRef.current === "create") {
        if (key.escape) {
          setPaletteModeSynced("list");
          setPaletteTitle("");
          paletteTitleRef.current = "";
          return;
        }
        if (key.return) {
          const title = paletteTitleRef.current.trim();
          if (title.length === 0) return;
          try {
            const id = taskCommands?.createTask({ title });
            setPaletteMessage({ text: `created ${id ?? "?"} — ${title}` });
            setPaletteModeSynced("list");
            setPaletteTitle("");
            paletteTitleRef.current = "";
            setSnapshot(application.snapshot());
          } catch (error) {
            setPaletteMessage({ text: error instanceof Error ? error.message : String(error), error: true });
          }
          return;
        }
        if (key.backspace || key.delete) {
          const next = paletteTitleRef.current.slice(0, -1);
          paletteTitleRef.current = next;
          setPaletteTitle(next);
          return;
        }
        if (input.length > 0 && !key.ctrl && !key.meta) {
          const next = paletteTitleRef.current + input;
          paletteTitleRef.current = next;
          setPaletteTitle(next);
        }
        return;
      }
      if (key.escape || input === "q") {
        setPaletteOpen(false);
        setPaletteMessage(undefined);
        return;
      }
      if (key.upArrow) {
        // The cursor mirrors into a ref (same stale-closure reasoning as the
        // mode ref): a burst like ↓↓↓a must land all four keys on fresh
        // values, not on the render-time paletteIndex.
        paletteIndexRef.current = clamp(paletteIndexRef.current - 1);
        setPaletteIndex(paletteIndexRef.current);
        return;
      }
      if (key.downArrow) {
        paletteIndexRef.current = clamp(paletteIndexRef.current + 1);
        setPaletteIndex(paletteIndexRef.current);
        return;
      }
      if (taskCommands === undefined) {
        // Read-only surface (hub views, tests without a port): the palette
        // lists tasks but every mutation key is inert.
        return;
      }
      const cursorTask = tasks[clamp(paletteIndexRef.current)];
      if ((key.return || input === "a") && cursorTask !== undefined) {
        try {
          taskCommands.activateTask(cursorTask.id);
          setPaletteMessage({ text: `activated ${cursorTask.id} — ${cursorTask.title}` });
          setSnapshot(application.snapshot());
        } catch (error) {
          // Kernel rejections (BLOCKED dependencies, non-activatable states)
          // are the operator-visible refusal — the palette shows them, the
          // canonical state never moved.
          setPaletteMessage({ text: error instanceof Error ? error.message : String(error), error: true });
        }
        return;
      }
      if (input === "r" && cursorTask !== undefined) {
        try {
          taskCommands.retryTask(cursorTask.id);
          setPaletteMessage({ text: `retried ${cursorTask.id}` });
          setSnapshot(application.snapshot());
        } catch (error) {
          setPaletteMessage({ text: error instanceof Error ? error.message : String(error), error: true });
        }
        return;
      }
      if (input === "n") {
        setPaletteModeSynced("create");
        setPaletteTitle("");
        paletteTitleRef.current = "";
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
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      if (transcript.length === 0) {
        setTranscript((current) => [...current, { label: "[export]", text: "refused: transcript is empty", dim: true, at: clock() }]);
        return;
      }
      const exportPath = resolve(process.cwd(), `workflow-transcript-${stamp}.md`);
      const markdown = [
        `# Workflow transcript`,
        ``,
        `_Exported ${new Date().toISOString()} · ${connectionLabel ?? "local"}_`,
        ``,
        ...transcript.map((entry) => `${entry.at !== undefined ? `_${entry.at}_ ` : ""}**${entry.label}**: ${entry.text}`),
        ``,
      ].join("\n");
      writeFileSync(exportPath, markdown, "utf8");
      setTranscript((current) => [...current, { label: "[exported]", text: exportPath, dim: true, at: clock() }]);
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
        setTranscript((current) => [...current, { label: "You (queued)", text: submitted, dim: true, at: clock() }]);
        setPromptHistory((current) => [...current, submitted].slice(-50));
        historyIndex.current = undefined;
        savedDraft.current = undefined;
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
        historyIndex.current = undefined;
        savedDraft.current = undefined;
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
      setTranscript((current) => [...current, { label: "You", text: submitted, at: clock() }]);
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
  const showActivityPanel = activeSession !== undefined || openReviewFollowUps || gates !== undefined;
  const composerRows = activeSession === undefined ? 0 : composerBackground === undefined ? 5 : 3;
  const transcriptRows = Math.max(4, (stdout.rows ?? 24) - chromeRows(showWorkflow, composerRows) - panelRows(snapshot, showActivityPanel));
  const end = Math.max(0, transcript.length - scrollOffset);
  const visibleTranscript = transcript.slice(Math.max(0, end - transcriptRows), end);
  const taskSummary = summarizeTasks(snapshot);
  const enforcement = snapshot.enforcementLevel.toUpperCase();

  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="column" width="100%" maxWidth={68} paddingX={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT_INTERACTIVE} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={ACCENT_INTERACTIVE}>◆ Workflow</Text>
            <Text>
              <Text bold color={enforcement === "ENFORCED" ? ACCENT_SUCCESS : ACCENT_WARNING}>{enforcement}</Text>
              <Text dimColor> · {snapshot.transport}{usageLine !== undefined ? ` · ${usageLine}` : ""}</Text>
            </Text>
          </Box>
          <Box justifyContent="space-between">
            <Text>
              <Text bold>Mode: {MODE_LABELS[mode]}</Text>
              {connectionLabel !== undefined ? <Text dimColor> · {connectionLabel}</Text> : null}
            </Text>
          </Box>
        </Box>
        {prompt.length === 0 && !menuOpen ? (
          <Text dimColor>keys: / menu · ^P menu · ^W state · ^E export · PgUp/PgDn scroll</Text>
        ) : null}
        {menuOpen ? (
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={ACCENT_INTERACTIVE} paddingX={1}>
            <Text bold color={ACCENT_INTERACTIVE}>Workflow options</Text>
            {menuItems.map((item, index) => {
              const active = index === menuIndex;
              return (
                <Text key={item.label} dimColor={!active} {...(active ? { color: ACCENT_INTERACTIVE } : {})}>
                  {active ? "❯ " : "  "}{index + 1} {item.label}
                </Text>
              );
            })}
            <Text dimColor>1-{menuItems.length} toggles in place · ↑↓ Enter runs · q/Esc closes · ^W state</Text>
          </Box>
        ) : null}
        {decisionBrief !== undefined ? <DecisionBriefDrawer brief={decisionBrief} /> : null}
        {checkpoint !== undefined ? <CheckpointDrawer opportunity={checkpoint} /> : null}
        {lesson !== undefined ? <DiagnosticLessonDrawer lesson={lesson} /> : null}
        {showProfile && learnerProfile !== undefined ? <ProfilePanel profile={learnerProfile} /> : null}
        {showHint ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={ACCENT_INTERACTIVE}>◆ Symbol Inspect</Text>
            <Text dimColor>Type a symbol name and press Enter{inspectQuery.length > 0 ? `: ${inspectQuery}` : ""}</Text>
          </Box>
        ) : null}
        {snapshot.tasks.length > 0 ? <TaskListPanel snapshot={snapshot} /> : null}
        {paletteOpen ? (
          <TaskPalette
            snapshot={snapshot}
            port={taskCommands}
            index={paletteIndex}
            mode={paletteMode}
            title={paletteTitle}
            message={paletteMessage}
          />
        ) : null}
        {showActivityPanel ? (
          <SessionActivityPanel state={sessionState} pendingTools={pendingTools} recentLogs={recentLogs} spinner={spinner} {...(reviewFollowUps === undefined ? {} : { reviewFollowUps })} {...(gates === undefined ? {} : { gateObservability: gates })} />
        ) : null}
        <Box flexDirection="column" minHeight={4}>
        {transcript.length === 0 ? (
          <Box marginTop={1} flexDirection="column" alignItems="center">
            <Box>
              <Text bold color={ACCENT_INTERACTIVE}>◆ Workflow</Text>
            </Box>
            {activeSession === undefined ? (
              <Box marginTop={1} marginBottom={1} flexDirection="column" alignItems="center">
                <Box>
                  <Text dimColor>Observing the canonical snapshot — this surface is read-only.</Text>
                </Box>
                <Box marginTop={1}>
                  <Text dimColor italic>/ options · ^W state · ^E export · PgUp/PgDn scroll</Text>
                </Box>
              </Box>
            ) : (
              <Box marginTop={1} marginBottom={1} flexDirection="column" alignItems="center">
                <Box>
                  <Text dimColor>model proposes · Workflow authorizes · evidence validates</Text>
                </Box>
                <Box marginTop={1}>
                  <Text dimColor italic>Ask anything · / options · ^E export · PgUp/PgDn scroll</Text>
                </Box>
              </Box>
            )}
          </Box>
        ) : null}
        {scrollOffset > 0 ? <Text dimColor>↑ {scrollOffset} newer entries · PgUp/PgDn</Text> : null}
        {visibleTranscript.map((entry, index) => {
          const accent = entryAccent(entry.label);
          return (
            <Text key={`${end}-${index}-${entry.label}`} dimColor={entry.dim === true}>
              {entry.at !== undefined ? <Text dimColor>{entry.at} </Text> : null}
              <Text bold={!entry.dim} {...(accent === undefined ? {} : { color: accent })}>{entry.label.padEnd(10)} </Text>{entry.text}
            </Text>
          );
        })}
        </Box>

        {activeSession !== undefined ? (
          <Box marginTop={1} flexDirection="column">
          <Box
            flexDirection="row"
            paddingX={1}
            {...(composerBackground === undefined
              ? { borderStyle: "round" as const, borderColor: ACCENT_INTERACTIVE }
              : { backgroundColor: composerBackground })}
          >
          {sessionState?.state === "running" ? (
            <Text>
              <Text bold color={ACCENT_INTERACTIVE}>{spinner}</Text>
              <Text bold> [running]</Text>
              <Text> {assistantLabel} is working · {elapsedSeconds}s</Text>
              <Text dimColor> · Ctrl+C cancel</Text>
            </Text>
          ) : (
            <Text>
              <Text bold color={ACCENT_INTERACTIVE}>❯ </Text>
              {prompt.length === 0 ? <Text dimColor italic>What do you want to build?</Text> : prompt}
            </Text>
          )}
          </Box>
          <Box justifyContent="space-between">
            <Text dimColor>{sessionState?.state ?? "idle"} · PgUp/PgDn scroll · ^E export</Text>
            <Text dimColor>{running ? "^C cancel" : "^C quit"}</Text>
          </Box>
          </Box>
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Text dimColor>{taskSummary} · epoch {snapshot.mutationEpoch}</Text>
          <Text dimColor>^W workflow</Text>
        </Box>

        {showWorkflow ? <WorkflowDetails snapshot={snapshot} /> : null}
      </Box>
    </Box>
  );
}

type SessionLog = Extract<CodingSessionEvent, { readonly type: "log" }>;

const TASK_PANEL_MAX_ROWS = 6;

/** Estimate of rows the fixed chrome occupies, used to bound the transcript. */
function chromeRows(showWorkflow: boolean, composerRows: number): number {
  const header = 5; // header box (border + two rows) + keys hint line
  const footer = 1;
  const margins = 2; // task panel + activity panel top margins
  const details = showWorkflow ? 9 : 0; // workflow details drawer
  return header + composerRows + footer + margins + details;
}

/** Estimate of rows the monitoring panels occupy, used to bound the transcript. */
function panelRows(snapshot: WorkflowSnapshot, showActivity: boolean): number {
  const taskRows = snapshot.tasks.length === 0
    ? 0
    : 3 + Math.min(snapshot.tasks.length, TASK_PANEL_MAX_ROWS) + (snapshot.tasks.length > TASK_PANEL_MAX_ROWS ? 1 : 0);
  const activityRows = showActivity ? 4 : 0;
  return taskRows + activityRows;
}

/**
 * W046 (open clause): the Ctrl+T task palette. Pure projection — every
 * mutation was already applied at the input-handler layer through the
 * taskCommands port; this component renders the list, the cursor, the
 * create-title entry, and the last port outcome (activation confirmations
 * and kernel rejections alike). Without a port it is read-only and says so.
 */
function TaskPalette({
  snapshot,
  port,
  index,
  mode,
  title,
  message,
}: {
  readonly snapshot: WorkflowSnapshot;
  readonly port: TaskCommandPort | undefined;
  readonly index: number;
  readonly mode: "list" | "create";
  readonly title: string;
  readonly message: { readonly text: string; readonly error?: boolean } | undefined;
}) {
  const tasks = snapshot.tasks;
  const clamped = Math.max(0, Math.min(index, tasks.length - 1));
  let activeId: string | undefined;
  try {
    activeId = port?.activeTaskId();
  } catch {
    activeId = undefined;
  }
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={ACCENT_INTERACTIVE} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Task palette</Text>
        <Text dimColor>{port === undefined ? "read-only (no task port on this surface)" : "Ctrl+T to close"}</Text>
      </Box>
      {mode === "create" ? (
        <Text>
          <Text bold color={ACCENT_INTERACTIVE}>new task title:</Text> {title}
          <Text dimColor> — ↵ create · esc back</Text>
        </Text>
      ) : tasks.length === 0 ? (
        <Text dimColor>no tasks yet{port === undefined ? "" : " — press n to create one"}</Text>
      ) : (
        tasks.map((task, taskIndex) => {
          const accent = taskStateAccent(task.state);
          const activeMark = task.id === activeId ? <Text bold color={ACCENT_INTERACTIVE}> ◂ active</Text> : null;
          return (
            <Text key={task.id} dimColor={accent.dim === true} {...(accent.color === undefined ? {} : { color: accent.color })}>
              {taskIndex === clamped ? "▸" : " "} {TASK_GLYPHS[task.state]} {task.id.padEnd(8)} {task.state.padEnd(11)} {task.title}
              {activeMark}
            </Text>
          );
        })
      )}
      {message !== undefined ? (
        <Text dimColor={message.error !== true} {...(message.error === true ? { color: ACCENT_FAILURE } : {})}>
          {message.error === true ? "✗ " : "· "}
          {message.text}
        </Text>
      ) : null}
      {port === undefined ? (
        <Text dimColor>read-only: this surface composes no task-command port</Text>
      ) : mode === "list" ? (
        <Text dimColor>↑/↓ move · a/↵ activate · n new · r retry failed · esc close</Text>
      ) : null}
    </Box>
  );
}

function TaskListPanel({ snapshot }: { readonly snapshot: WorkflowSnapshot }) {
  const total = snapshot.tasks.length;
  const verified = snapshot.tasks.filter((task) => task.state === "VERIFIED").length;
  const visible = snapshot.tasks.slice(0, TASK_PANEL_MAX_ROWS);
  const segments = Math.min(total, 20);
  const filled = Math.round((verified / total) * segments);
  const bar = "▰".repeat(filled) + "▱".repeat(segments - filled);
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={ACCENT_FRAME} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Tasks</Text>
        <Text dimColor>{bar} {verified}/{total} verified</Text>
      </Box>
      {visible.map((task) => {
        const accent = taskStateAccent(task.state);
        return (
          <Text key={task.id} dimColor={accent.dim === true} {...(accent.color === undefined ? {} : { color: accent.color })}>
            {TASK_GLYPHS[task.state]} {task.id.padEnd(8)} {task.state.padEnd(11)} {task.title}
          </Text>
        );
      })}
      {total > TASK_PANEL_MAX_ROWS ? <Text dimColor>… {total - TASK_PANEL_MAX_ROWS} more (^W details)</Text> : null}
    </Box>
  );
}

function taskStateAccent(state: TaskState): { color?: string; dim?: boolean } {
  if (state === "VERIFIED") return { color: ACCENT_SUCCESS };
  if (state === "IN_PROGRESS") return { color: ACCENT_INTERACTIVE };
  if (state === "VERIFYING") return { color: ACCENT_WARNING };
  if (state === "FAILED") return { color: ACCENT_FAILURE };
  return { dim: true };
}

function SessionActivityPanel({
  state,
  pendingTools,
  recentLogs,
  spinner,
  reviewFollowUps,
  gateObservability,
}: {
  readonly state: CodingSessionState | undefined;
  readonly pendingTools: readonly string[];
  readonly recentLogs: readonly SessionLog[];
  readonly spinner: string;
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
  // W044 (open clause): hub-side per-run usage from the metering proxy.
  const runUsage = Object.entries(gateObservability?.usage ?? {});
  const sessionState = state?.state;
  const stateAccent = sessionStateAccent(sessionState);
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={ACCENT_FRAME} paddingX={1}>
      <Text bold>Activity <Text dimColor {...(stateAccent === undefined ? {} : { color: stateAccent })}>{sessionState ?? "idle"}</Text></Text>
      {pendingTools.length > 0 ? (
        <Text color={ACCENT_INTERACTIVE}>  in flight: {pendingTools.map((tool) => `${spinner} ${tool}`).join("   ")}</Text>
      ) : null}
      {recentLogs.map((log, index) => {
        const logAccent = log.level === "warning" ? ACCENT_WARNING : log.level === "error" ? ACCENT_FAILURE : undefined;
        return (
          <Text key={index} dimColor={log.level === "debug"} {...(logAccent === undefined ? {} : { color: logAccent })}>
            {`  [${log.level}] ${log.source === undefined ? "" : `${log.source}: `}${log.message}`}
          </Text>
        );
      })}
      {openFollowUps.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>  review follow-ups ({openFollowUps.length} open)</Text>
          {openFollowUps.slice(0, 3).map((item) => (
            <Text key={item.id} dimColor>    [<Text color={ACCENT_WARNING}>{item.severity}</Text>] {item.summary}</Text>
          ))}
        </Box>
      ) : null}
      {blockedRuns.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color={ACCENT_FAILURE}>  blocked runs ({blockedRuns.length})</Text>
          {blockedRuns.slice(0, 3).map(([runId, reason]) => (
            <Text key={runId} color={ACCENT_FAILURE}>    [blocked] {shortRun(runId)}: {reason.slice(0, 120)}</Text>
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
            <Text key={runId} color={ACCENT_WARNING}>    [unverified claim] {shortRun(runId)}: {claim.claim.slice(0, 90)}</Text>
          ))}
        </Box>
      ) : null}
      {runUsage.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>  run usage (hub metering, last {Math.min(runUsage.length, 3)})</Text>
          {runUsage.slice(-3).map(([runId, usage]) => (
            <Text key={runId} dimColor>    {shortRun(runId)}: {usage.totalTokens} tokens · ${usage.costUsd.toFixed(4)} · {usage.requests} requests</Text>
          ))}
        </Box>
      ) : null}
      {pendingTools.length === 0 && recentLogs.length === 0 && openFollowUps.length === 0 && blockedRuns.length === 0 && verdicts.length === 0 && unverifiedClaims.length === 0 && runUsage.length === 0 ? <Text dimColor>No live activity.</Text> : null}
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
      <Text bold color={ACCENT_INTERACTIVE}>◆ Decision Brief: {brief.title}</Text>
      <Text dimColor>{brief.context}</Text>
      <Text>  chosen: <Text bold>{brief.chosenOption.name}</Text> <Text dimColor>({brief.chosenOption.blastRadius} blast radius)</Text></Text>
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
      <Text bold color={ACCENT_INTERACTIVE}>◆ Socratic Question: {opportunity.concept}</Text>
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
      <Text bold color={ACCENT_INTERACTIVE}>◆ Lesson TS{lesson.code}: {lesson.file}:{lesson.line}:{lesson.column}</Text>
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
      <Text bold color={ACCENT_INTERACTIVE}>◆ Learner Profile</Text>
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
        evidence {snapshot.evidence.length} | transitions {snapshot.history.length} | ^W close
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
  return { ...projectSessionEvent(event, assistantLabel), at: clock() };
}

function projectSessionEvent(event: CodingSessionEvent, assistantLabel: string): TranscriptEntry {
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
  if (event.type === "thought") {
    return { label: "[thought]", text: event.text, dim: true };
  }
  if (event.type === "tool") {
    const marker = event.status === "completed" ? "[ok]" : event.status === "error" || event.status === "cancelled" ? "[failed]" : "[tool]";
    return {
      label: marker,
      text: `${event.title}${event.subjects.length > 0 ? ` ${event.subjects.join(", ")}` : ""}`,
      dim: event.status === "completed",
    };
  }
  if (event.type === "plan") {
    const done = event.entries.filter((entry) => entry.status === "completed").length;
    return { label: "[plan]", text: `${event.entries.length} steps, ${done} completed`, dim: true };
  }
  if (event.type === "agent-context") {
    // W047 (G7 context visibility): agent-emitted usage/context signals —
    // standard kinds the projection doesn't specialize (usage_update) and
    // agent-custom channels (goose) — render as dim advisory rows.
    return { label: "[context]", text: describeAgentContext(event.kind, event.payload), dim: true };
  }
  if (event.type === "session-info") return { label: "[session]", text: event.title, dim: true };
  if (event.type === "completed") return { label: "completed", text: event.result };
  return { label: "failed", text: (event as { type: "failed"; reason: string }).reason };
}

/** W047: a compact, honest one-line summary of an advisory context payload. */
function describeAgentContext(kind: string, payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const usageParts: string[] = [];
    for (const key of ["totalTokens", "promptTokens", "completionTokens", "costUsd", "inputTokens", "outputTokens"]) {
      const value = record[key];
      if (typeof value === "number") usageParts.push(key === "costUsd" ? `$${value}` : `${key} ${value}`);
    }
    if (usageParts.length > 0) return `${kind}: ${usageParts.join(" · ")}`;
  }
  return kind;
}
