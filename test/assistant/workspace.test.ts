import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configPath, ensureWorkspace, resolveWorkspace, type Config } from "../../src/assistant/config.js";

const KEYS = ["AUGUR_WORKSPACE", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "AUGUR_CONFIG"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withEnv<T>(saved: Record<string, string | undefined>, fn: () => T): T {
  try {
    return fn();
  } finally {
    restoreEnv(saved);
  }
}

test("resolveWorkspace uses AUGUR_WORKSPACE when no flag or config value", () => {
  const saved = snapshotEnv();
  withEnv(saved, () => {
    process.env.AUGUR_WORKSPACE = "/tmp/x";
    delete process.env.XDG_DATA_HOME;
    assert.equal(resolveWorkspace({} as Config), "/tmp/x");
  });
});

test("resolveWorkspace flag beats env", () => {
  const saved = snapshotEnv();
  withEnv(saved, () => {
    process.env.AUGUR_WORKSPACE = "/tmp/env-ws";
    assert.equal(resolveWorkspace({} as Config, "/flag/ws"), "/flag/ws");
  });
});

test("resolveWorkspace uses config value when no flag or env", () => {
  const saved = snapshotEnv();
  withEnv(saved, () => {
    delete process.env.AUGUR_WORKSPACE;
    delete process.env.XDG_DATA_HOME;
    assert.equal(resolveWorkspace({ workspace: "/cfg/ws" } as Config), "/cfg/ws");
  });
});

test("resolveWorkspace defaults under XDG_DATA_HOME", () => {
  const saved = snapshotEnv();
  withEnv(saved, () => {
    delete process.env.AUGUR_WORKSPACE;
    process.env.XDG_DATA_HOME = "/tmp/d";
    assert.equal(resolveWorkspace({} as Config), "/tmp/d/augur/workspace");
  });
});

test("ensureWorkspace creates nested directory and returns it", () => {
  const dir = `/tmp/augur-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}/nested`;
  try {
    assert.equal(ensureWorkspace(dir), dir);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configPath honors XDG_CONFIG_HOME when AUGUR_CONFIG is unset", () => {
  const saved = snapshotEnv();
  withEnv(saved, () => {
    delete process.env.AUGUR_CONFIG;
    process.env.XDG_CONFIG_HOME = "/tmp/c";
    assert.equal(configPath(), join("/tmp/c", "augur", "config.yaml"));
  });
});
