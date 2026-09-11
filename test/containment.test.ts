import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { WorkflowContainedProcess } from "../src/containment/workflow-process.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";

const processTask: WorkflowTask = {
  id: taskId("process-task"),
  title: "contained process",
  state: "BLOCKED",
  dependencies: [],
  requiredEvidence: [],
};

test("contained process requires Workflow process authorization before runtime enforcement", async () => {
  const graph = new TaskGraph([processTask]);
  graph.transition(processTask.id, "IN_PROGRESS");
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  const deniedApplication = new WorkflowApplication(graph, host);
  const denied = new WorkflowContainedProcess(deniedApplication, new LinuxBubblewrapContainment());

  await assert.rejects(
    () =>
      denied.execute(
        {
          sessionId: "session",
          taskId: processTask.id,
          tool: "contained-process",
          capability: "process",
          mutating: true,
          subjects: ["runtime"],
          input: {},
        },
        { executable: "/usr/bin/true", args: [] },
      ),
    /CAPABILITY_WITHHELD/,
  );

  const allowedApplication = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]));
  const allowed = new WorkflowContainedProcess(allowedApplication, new LinuxBubblewrapContainment());
  const result = await allowed.execute(
    {
      sessionId: "session",
      taskId: processTask.id,
      tool: "contained-process",
      capability: "process",
      mutating: true,
      subjects: ["runtime"],
      input: {},
    },
    { executable: "/usr/bin/true", args: [] },
  );
  assert.equal(result.enforcement, "enforced");
});

test("explicit environment requires Workflow credential authorization", async () => {
  const graph = new TaskGraph([processTask]);
  graph.transition(processTask.id, "IN_PROGRESS");
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  const application = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]));
  const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());

  await assert.rejects(
    () =>
      process.execute(
        {
          sessionId: "session",
          taskId: processTask.id,
          tool: "contained-process",
          capability: "process",
          mutating: true,
          subjects: ["runtime"],
          input: {},
        },
        { executable: "/usr/bin/env", args: [], environment: { WORKFLOW_TEST_CREDENTIAL: "secret" } },
      ),
    /CAPABILITY_WITHHELD.*credentials/,
  );
});

test("Linux containment clears ambient credentials and disables network by default", async () => {
  const runtime = new LinuxBubblewrapContainment();
  const result = await runtime.execute({
    executable: "/usr/bin/env",
    args: [],
  });

  assert.equal(result.enforcement, "enforced");
  assert.equal(result.network, "isolated");
  assert.equal(result.credentials, "cleared");
  assert.doesNotMatch(result.stdout, /HOME=|TOKEN=|SECRET=|KEY=/);
});

test("Linux containment hides ambient filesystem paths unless explicitly granted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-sentinel-"));
  const sentinel = join(directory, "ambient-sentinel");
  try {
    await writeFile(sentinel, "ambient-host-file");
    assert.equal(await readFile(sentinel, "utf8"), "ambient-host-file");

    const runtime = new LinuxBubblewrapContainment();
    const hidden = await runtime.execute({
      executable: "/bin/sh",
      args: ["-c", `test ! -e '${sentinel}'`],
    });
    assert.equal(hidden.exitCode, 0);

    const visible = await runtime.execute({
      executable: "/bin/cat",
      args: [sentinel],
      readablePaths: [sentinel],
    });
    assert.equal(visible.exitCode, 0);
    assert.equal(visible.stdout, "ambient-host-file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writable grants require Workflow mutation authorization even when caller marks the action non-mutating", async () => {
  const graph = new TaskGraph([processTask]);
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  const application = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]));
  const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-auth-"));
  try {
    await assert.rejects(
      () =>
        process.execute(
          {
            sessionId: "session",
            taskId: processTask.id,
            tool: "contained-process",
            capability: "process",
            mutating: false,
            subjects: ["runtime"],
            input: {},
          },
          { executable: "/usr/bin/true", args: [], writablePaths: [directory] },
        ),
      /TASK_NOT_IN_PROGRESS/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host networking requires Workflow network authorization", async () => {
  const graph = new TaskGraph([processTask]);
  graph.transition(processTask.id, "IN_PROGRESS");
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  const application = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]));
  const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());

  await assert.rejects(
    () =>
      process.execute(
        {
          sessionId: "session",
          taskId: processTask.id,
          tool: "contained-process",
          capability: "process",
          mutating: true,
          subjects: ["runtime"],
          input: {},
        },
        { executable: "/usr/bin/true", args: [], network: "host" },
      ),
    /CAPABILITY_WITHHELD.*network/,
  );
});

test("Linux containment creates a network namespace with no host interfaces", async () => {
  const runtime = new LinuxBubblewrapContainment();
  const result = await runtime.execute({
    executable: "/bin/cat",
    args: ["/proc/net/dev"],
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\blo:/);
  assert.doesNotMatch(result.stdout, /enp|eth|wlan|wlp/);
});

test("Linux containment rejects writable filesystem access unless explicitly granted", async () => {
  const runtime = new LinuxBubblewrapContainment();
  const denied = await runtime.execute({
    executable: "/usr/bin/touch",
    args: ["/tmp/workflow-containment-denied"],
  });

  assert.notEqual(denied.exitCode, 0);
});

test("Linux containment permits writes only through an explicit writable grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-"));
  const output = join(directory, "proof");
  try {
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({
      executable: "/bin/sh",
      args: ["-c", 'printf contained > "$1"', "workflow", output],
      writablePaths: [directory],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(output, "utf8"), "contained");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux containment rejects malformed executable and filesystem grants", async () => {
  const runtime = new LinuxBubblewrapContainment();

  await assert.rejects(() => runtime.execute({ executable: "sh", args: [] }), /absolute path/);
  await assert.rejects(
    () => runtime.execute({ executable: "/usr/bin/true", args: [], readablePaths: ["relative"] }),
    /absolute path/,
  );
  await assert.rejects(
    () => runtime.execute({ executable: "/usr/bin/true", args: [], network: "invalid" as "host" }),
    /network must be isolated or host/,
  );
});

test("Linux containment fails closed when bubblewrap is unavailable", async () => {
  const runtime = new LinuxBubblewrapContainment("/definitely/missing/bwrap");

  await assert.rejects(
    () => runtime.execute({ executable: "/usr/bin/true", args: [] }),
    /containment backend unavailable/,
  );
});

test("Linux containment does not mistake an executable for a working backend", async () => {
  const runtime = new LinuxBubblewrapContainment("/usr/bin/false");

  await assert.rejects(
    () => runtime.execute({ executable: "/usr/bin/true", args: [] }),
    /containment backend failed runtime probe/,
  );
});

test("Linux containment never reports enforcement when a requested boundary cannot be mounted", async () => {
  const runtime = new LinuxBubblewrapContainment();

  await assert.rejects(
    () =>
      runtime.execute({
        executable: "/usr/bin/true",
        args: [],
        readablePaths: ["/definitely/missing/workflow-containment-path"],
      }),
    /containment boundary could not be established/,
  );
});
