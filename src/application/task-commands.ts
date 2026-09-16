import { randomUUID } from "node:crypto";

import { evidenceId, observationId, taskId, type TaskId, type WorkflowTask } from "../kernel/contracts.js";
import type { WorkflowApplication } from "./workflow.js";

/**
 * W046 (per-prompt task decomposition): the deterministic task-command port
 * for interactive sessions. Surfaces — never the model — drive canonical
 * task lifecycle through APPLICATION COMMANDS ONLY: the kernel keeps
 * validating existence, acyclicity, readiness derivation, legal transitions,
 * and evidence-gated verification, and the TaskGraph itself is never handed
 * out. Model-proposed decomposition arrives through the advisory `plan`
 * projection and becomes canonical ONLY when an operator (or an explicit
 * rule, like the hub's run/team-task flows) confirms it through this port.
 *
 * Authorization correlation: interactive surfaces compose their ACP driver
 * with the lazy `() => application.activeTaskId()` correlation, so after
 * `activateTask` every subsequent tool proposal authorizes against the
 * newly active task; blocked work (nothing IN_PROGRESS) fails closed at the
 * application gate exactly as before.
 */
export interface TaskCommandPort {
  /** Kernel-validated creation (BLOCKED until dependencies verify). */
  createTask(request: {
    readonly id?: TaskId;
    readonly title: string;
    readonly dependencies?: readonly TaskId[];
    readonly requiredEvidence?: WorkflowTask["requiredEvidence"];
  }): TaskId;
  /** Start a READY task and make it the active authorization target. */
  activateTask(id: TaskId): void;
  /** Evidence-driven completion: IN_PROGRESS → VERIFYING → VERIFIED. */
  completeTask(id: TaskId, evidence: readonly {
    readonly subject: string;
    readonly detail?: string;
  }[]): void;
  /** FAILED → READY/BLOCKED by dependency readiness (kernel-decided). */
  retryTask(id: TaskId): void;
  /** The currently active authorization target, when one is IN_PROGRESS. */
  activeTaskId(): TaskId | undefined;
}

/** Correlates with no active IN_PROGRESS task — never a real task id. */
export const NO_ACTIVE_TASK_ID: TaskId = taskId("no-active-task");

/**
 * W046: the lazy task correlation interactive surfaces stamp onto their ACP
 * driver. Every proposal re-reads the application's active-task pointer at
 * request time. When no task is IN_PROGRESS (nothing activated yet, or the
 * active task just completed) the pointer is dead — correlating with a
 * NON-EXISTENT sentinel id is the fail-closed form: the application gate
 * denies UNKNOWN_TASK and the wire request still gets answered. A throwing
 * getter would instead leave the ACP permission request unanswered, so this
 * correlator never throws.
 */
export function activeTaskCorrelation(application: WorkflowApplication): () => TaskId {
  return () => {
    try {
      return application.activeTaskId();
    } catch {
      return NO_ACTIVE_TASK_ID;
    }
  };
}

export function createTaskCommandPort(application: WorkflowApplication): TaskCommandPort {
  let sequence = 0;
  const nextId = (): TaskId => {
    sequence += 1;
    return taskId(`interactive-task-${randomUUID().slice(0, 8)}-${sequence}`);
  };

  return {
    createTask(request) {
      const id = request.id ?? nextId();
      application.addTask({
        id,
        title: request.title,
        dependencies: [...(request.dependencies ?? [])],
        requiredEvidence: [...(request.requiredEvidence ?? [])],
      });
      return id;
    },

    activateTask(id) {
      const task = application.snapshot().tasks.find((entry) => entry.id === id);
      if (task === undefined) {
        throw new Error(`cannot activate unknown task ${JSON.stringify(id)}`);
      }
      if (task.state === "READY") {
        application.transition(id, "IN_PROGRESS");
      } else if (task.state !== "IN_PROGRESS") {
        // BLOCKED (dependencies unverified), VERIFIED, FAILED, VERIFYING —
        // never guess; the operator sees the blockers in the task list.
        throw new Error(`cannot activate task ${JSON.stringify(id)} in state ${task.state}`);
      }
      application.selectActiveTask(id);
    },

    completeTask(id, evidence) {
      const task = application.snapshot().tasks.find((entry) => entry.id === id);
      if (task === undefined) {
        throw new Error(`cannot complete unknown task ${JSON.stringify(id)}`);
      }
      if (task.state === "IN_PROGRESS") {
        application.transition(id, "VERIFYING");
      } else if (task.state !== "VERIFYING") {
        throw new Error(`cannot complete task ${JSON.stringify(id)} in state ${task.state}`);
      }
      // Fresh environment evidence at the current mutation epoch; the kernel
      // decides whether every requiredEvidence subject is satisfied — tool
      // success alone never verifies a canonical task.
      for (const observation of evidence) {
        application.recordEvidence({
          id: evidenceId(`interactive-evidence:${randomUUID()}`),
          observationId: observationId(`interactive:${id}:${observation.subject}`),
          authority: "environment",
          subject: observation.subject,
          result: "passed",
          freshness: "fresh",
          mutationEpoch: application.snapshot().mutationEpoch,
          observedAt: new Date().toISOString(),
          ...(observation.detail === undefined ? {} : { detail: observation.detail }),
        });
      }
      application.transition(id, "VERIFIED");
    },

    retryTask(id) {
      application.retryFailedTask(id);
    },

    activeTaskId() {
      try {
        return application.activeTaskId();
      } catch {
        return undefined;
      }
    },
  };
}
