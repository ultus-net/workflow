import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { WorkflowApplication } from "../application/workflow.js";
import { evidenceId, observationId, taskId, type TaskId } from "../kernel/contracts.js";
import type { TaskGraph } from "../kernel/task-graph.js";
import { countReferencedAxes, MIN_REFERENCED_AXES } from "../review/rubric.js";
import type { WorkflowApplicationResolver, WorkflowRunController } from "./cline-tui-bridge.js";


/**
 * Resolves the WorkflowApplication for a surface-declared workspace and
 * manages dedicated task/evidence lifecycles for scheduled runs. Each
 * workspace gets a lazily created application over the hub's shared task
 * graph, so task/evidence state is global while workspace-path authorization
 * is per surface; each run gets its own task and records its own evidence.
 * Invalid declarations throw, which the bridge surfaces as an authority error
 * (clients fail closed). See `docs/HUB_PROTOCOL.md` §3.
 */
export function createRunRegistry(
  fallback: WorkflowApplication,
  graph: TaskGraph,
): { resolve: WorkflowApplicationResolver; controller: WorkflowRunController } {
  const workspaceApplications = new Map<string, WorkflowApplication>();
  const runs = new Map<string, WorkflowApplication>();

  const workspaceApplication = (workspace: string | undefined): WorkflowApplication => {
    if (workspace === undefined) return fallback;
    if (!isAbsolute(workspace)) throw new TypeError(`declared workspace must be absolute: ${workspace}`);
    if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new TypeError(`declared workspace is not an existing directory: ${workspace}`);
    }
    let application = workspaceApplications.get(workspace);
    if (application === undefined) {
      application = new WorkflowApplication(graph, fallback.host, [], fallback.allowedCapabilities, workspace);
      application.startInteractiveTask();
      workspaceApplications.set(workspace, application);
    }
    return application;
  };

  return {
    resolve(workspace?: string, runId?: string): WorkflowApplication {
      if (runId !== undefined) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        return application;
      }
      return workspaceApplication(workspace);
    },
    controller: {
      async begin({ runId, title, workspace, requiresReview }) {
        if (runId.trim().length === 0 || title.trim().length === 0) {
          throw new TypeError("run begin requires a non-empty runId and title");
        }
        if (runs.has(runId)) throw new TypeError(`duplicate run: ${runId}`);
        const parent = workspaceApplication(workspace);
        const application = new WorkflowApplication(
          graph,
          fallback.host,
          [],
          fallback.allowedCapabilities,
          parent.workspaceRoot,
        );
        const runTaskId: TaskId = taskId(`run:${runId}`);
        application.addTask({
          id: runTaskId,
          title,
          dependencies: [],
          // Review-gated runs cannot reach VERIFIED without reviewer evidence.
          requiredEvidence: requiresReview === true ? [{ authority: "reviewer" as const, subject: runId }] : [],
        });
        const started = application.transition(runTaskId, "IN_PROGRESS");
        if (started.kind !== "accepted") throw new Error(`cannot start run ${runId}: ${started.reason}`);
        application.selectActiveTask(runTaskId);
        runs.set(runId, application);
      },
      async review({ runId, reviewerRunId, verdict, summary }) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        if (!runs.has(reviewerRunId)) throw new TypeError(`unknown reviewer run: ${reviewerRunId}`);
        // Anti-rubber-stamp: a run cannot review itself (ported from
        // opencode-workflow-guard's subagent-only record_review).
        if (reviewerRunId === runId) throw new TypeError("a run cannot review itself");
        if (verdict === "approved" && countReferencedAxes(summary) < MIN_REFERENCED_AXES) {
          throw new TypeError(
            `review summary must reference at least ${MIN_REFERENCED_AXES} of the 5 axes (found ${countReferencedAxes(summary)})`,
          );
        }
        if (verdict !== "approved") return { recorded: false };
        application.recordMutation([runId]);
        application.recordEvidence({
          id: evidenceId(`review-evidence:${runId}`),
          observationId: observationId(`review-observation:${runId}:${reviewerRunId}`),
          authority: "reviewer",
          subject: runId,
          result: "passed",
          freshness: "fresh",
          mutationEpoch: application.snapshot().mutationEpoch,
          observedAt: new Date().toISOString(),
        });
        return { recorded: true };
      },
      async finish({ runId, outcome }) {
        const application = runs.get(runId);
        if (application === undefined) throw new TypeError(`unknown run: ${runId}`);
        const runTaskId = taskId(`run:${runId}`);
        if (outcome === "verified") {
          // No mutation here: verification observes the world as the run left
          // it. Mutating at finish time would invalidate the reviewer and
          // environment evidence that is supposed to validate this run.
          const current = application.snapshot().tasks.find((task) => task.id === runTaskId)?.state;
          if (current === "IN_PROGRESS") {
            const verifying = application.transition(runTaskId, "VERIFYING");
            if (verifying.kind !== "accepted") throw new Error(`cannot verify run ${runId}: ${verifying.reason}`);
          } else if (current !== "VERIFYING") {
            throw new Error(`cannot verify run ${runId}: task is ${current}`);
          }
          application.recordEvidence({
            id: evidenceId(`run-evidence:${runId}`),
            observationId: observationId(`run-observation:${runId}`),
            authority: "environment",
            subject: runId,
            result: "passed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
          });
          const verified = application.transition(runTaskId, "VERIFIED");
          if (verified.kind !== "accepted") throw new Error(`cannot verify run ${runId}: ${verified.reason}`);
        } else {
          application.recordMutation([runId]);
          application.recordEvidence({
            id: evidenceId(`run-evidence:${runId}`),
            observationId: observationId(`run-observation:${runId}`),
            authority: "environment",
            subject: runId,
            result: "failed",
            freshness: "fresh",
            mutationEpoch: application.snapshot().mutationEpoch,
            observedAt: new Date().toISOString(),
          });
          application.transition(runTaskId, "FAILED");
        }
        runs.delete(runId);
      },
    },
  };
}