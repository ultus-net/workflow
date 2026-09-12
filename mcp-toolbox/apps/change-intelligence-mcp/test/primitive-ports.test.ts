import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPrimitivePorts } from "../src/primitive-ports.ts";

test("normalizes required Git capability launch failures", async () => {
  const previous = process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
  process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = "definitely-not-a-real-git-intelligence-command";
  try {
    const ports = createPrimitivePorts();
    await assert.rejects(
      ports.git.workingTreeStatus({ workspaceRoot: process.cwd(), limit: 1 }),
      { message: "required capability git.working_tree_status failed" },
    );
  } finally {
    if (previous === undefined) delete process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
    else process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = previous;
  }
});

test("forwards cancellation to the primitive MCP request", async () => {
  const previousCommand = process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
  const previousArgs = process.env.CHANGE_INTELLIGENCE_GIT_ARGS;
  const here = dirname(fileURLToPath(import.meta.url));
  process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = process.execPath;
  process.env.CHANGE_INTELLIGENCE_GIT_ARGS = JSON.stringify(["--import", "tsx", resolve(here, "../../git-intelligence-mcp/src/server.ts")]);
  try {
    const ports = createPrimitivePorts();
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        ports.git.workingTreeStatus({ workspaceRoot: process.cwd(), limit: 1 }, controller.signal),
        { message: "required capability git.working_tree_status failed" },
      );
    } finally {
      await ports.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
    else process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.CHANGE_INTELLIGENCE_GIT_ARGS;
    else process.env.CHANGE_INTELLIGENCE_GIT_ARGS = previousArgs;
  }
});

test("rejects primitive responses that exceed the requested bound", async () => {
  const previousCommand = process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
  const previousArgs = process.env.CHANGE_INTELLIGENCE_GIT_ARGS;
  const here = dirname(fileURLToPath(import.meta.url));
  process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = process.execPath;
  process.env.CHANGE_INTELLIGENCE_GIT_ARGS = JSON.stringify(["--import", "tsx", resolve(here, "fixtures/over-returning-git-server.ts")]);
  try {
    const ports = createPrimitivePorts();
    try {
      await assert.rejects(
        ports.git.workingTreeStatus({ workspaceRoot: process.cwd(), limit: 1 }),
        { message: "required capability git.working_tree_status failed" },
      );
    } finally {
      await ports.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.CHANGE_INTELLIGENCE_GIT_COMMAND;
    else process.env.CHANGE_INTELLIGENCE_GIT_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.CHANGE_INTELLIGENCE_GIT_ARGS;
    else process.env.CHANGE_INTELLIGENCE_GIT_ARGS = previousArgs;
  }
});
