import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("contained process fails closed before runtime when a filesystem grant escapes the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "workflow-authorized-workspace-"));
  try {
    const graph = new TaskGraph([processTask]);
    graph.transition(processTask.id, "IN_PROGRESS");
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    );
    const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());

    await assert.rejects(
      () => process.execute(
        {
          sessionId: "session",
          taskId: processTask.id,
          tool: "contained-process",
          capability: "process",
          mutating: true,
          subjects: [],
          input: {},
        },
        {
          executable: "/bin/sh",
          args: ["-c", "printf escaped > ../escaped.txt"],
          cwd: workspace,
          readablePaths: [workspace],
          writablePaths: [join(workspace, "..")],
        },
      ),
      /WORKSPACE_PATH_DENIED/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("contained process denies a symlink grant that escapes the workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workflow-containment-symlink-grant-"));
  const workspace = join(parent, "repository");
  const outside = join(parent, "outside");
  try {
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink(outside, join(workspace, "escape"));
    const graph = new TaskGraph([processTask]);
    graph.transition(processTask.id, "IN_PROGRESS");
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    );
    const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());

    await assert.rejects(
      () => process.execute(
        {
          sessionId: "session",
          taskId: processTask.id,
          tool: "contained-process",
          capability: "process",
          mutating: true,
          subjects: [],
          input: {},
        },
        {
          executable: "/usr/bin/true",
          args: [],
          cwd: workspace,
          readablePaths: [join(workspace, "escape")],
          writablePaths: [join(workspace, "escape")],
        },
      ),
      /WORKSPACE_PATH_DENIED/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
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

test("Linux containment execs an executable stored outside the system binds", async () => {
  // Regression: bwrap execs the child inside the new mount tree, so a binary
  // living outside /usr (e.g. the vendored compiled Cline binary under the
  // repository) is invisible unless explicitly bound — the first live
  // contained-Cline run died instantly on execvp ENOENT.
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-exec-"));
  const executable = join(directory, "contained-true");
  try {
    await copyFile("/usr/bin/true", executable);
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({ executable, args: [] });
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux containment execs a symlinked launcher at its requested path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-symlink-"));
  const target = join(directory, "contained-true");
  const launcher = join(directory, "cliny");
  try {
    await copyFile("/usr/bin/true", target);
    await symlink(target, launcher);
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({ executable: launcher, args: [] });
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("Linux containment read-write-no-delete blocks deletion and creation while preserving writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-no-delete-"));
  const existing = join(directory, "keep.txt");
  const created = join(directory, "created.txt");
  try {
    await writeFile(existing, "original");
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({
      executable: "/bin/sh",
      args: [
        "-c",
        'printf modified > "$1"; printf new > "$2" 2>/dev/null; rm "$1" 2>/dev/null; exit 0',
        "workflow",
        existing,
        created,
      ],
      writablePaths: [directory],
      writableMountMode: "read-write-no-delete",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(existing, "utf8"), "modified");
    await assert.rejects(() => readFile(created, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux containment read-write mode permits deleting entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-delete-"));
  const existing = join(directory, "keep.txt");
  try {
    await writeFile(existing, "original");
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({
      executable: "/bin/sh",
      args: ["-c", 'rm "$1"', "workflow", existing],
      writablePaths: [directory],
      writableMountMode: "read-write",
    });

    assert.equal(result.exitCode, 0);
    await assert.rejects(() => readFile(existing, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux containment rejects an unknown writable mount mode", async () => {
  const runtime = new LinuxBubblewrapContainment();
  await assert.rejects(
    () => runtime.execute({ executable: "/usr/bin/true", args: [], writableMountMode: "read-only" as "read-write" }),
    /writableMountMode must be/,
  );
});

test("repository-scoped contained writes preserve unrelated dirty worktree content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-containment-dirty-"));
  const dirty = join(directory, "dirty.txt");
  const output = join(directory, "generated.txt");
  try {
    await writeFile(dirty, "committed\n");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["add", "dirty.txt"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", "commit", "-qm", "fixture"], { cwd: directory });
    await writeFile(dirty, "user change\n");
    const runtime = new LinuxBubblewrapContainment();
    const result = await runtime.execute({
      executable: "/bin/sh",
      args: ["-c", 'printf generated > "$1"', "workflow", output],
      cwd: directory,
      readablePaths: [directory],
      writablePaths: [directory],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(output, "utf8"), "generated");
    assert.equal(await readFile(dirty, "utf8"), "user change\n");
    assert.match(execFileSync("git", ["status", "--short"], { cwd: directory, encoding: "utf8" }), /^ M dirty\.txt$/m);
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
