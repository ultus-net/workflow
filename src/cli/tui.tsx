import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createWorkflowClineTuiBridge } from "../integrations/cline-tui-bridge.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { codexPetStateFramesBraille } from "../ui/pets/codex-pet-braille.js";
import { parseCodexPet } from "../ui/pets/codex-pet.js";
import { WORKFLOW_MARK } from "../ui/tui.js";
import { resolveTuiPetDir, resolveTuiWorkspace } from "./tui-args.js";

const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());
const petDir = resolveTuiPetDir(process.argv.slice(2), process.cwd());
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clineRoot = resolve(root, ".workflow-cline", "cline");
const tasks: WorkflowTask[] = [
  {
    id: taskId("W001"),
    title: "Inspect the runnable Workflow TUI",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  },
  {
    id: taskId("W002"),
    title: "Observe dependency-derived readiness",
    state: "BLOCKED",
    dependencies: [taskId("W001")],
    requiredEvidence: [],
  },
];

const application = new WorkflowApplication(
  new TaskGraph(tasks),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

const PET_HOME_CELL_WIDTH = 32;
const PET_STATUS_CELL_WIDTH = 14;
const PET_FRAME_DELAY_MS = 120;

application.startInteractiveTask();
const petAnimations = petDir === undefined ? undefined : await writePetAnimations(petDir);
const bridge = await createWorkflowClineTuiBridge(application);
try {
  const exitCode = await runClineTui(clineRoot, workspace, bridge.url, bridge.token, petAnimations);
  process.exitCode = exitCode;
} finally {
  await bridge.close();
}

async function writePetAnimations(dir: string): Promise<{ home: string; status: string }> {
  let petJson: string;
  let spritesheet: Uint8Array;
  try {
    petJson = await readFile(join(dir, "pet.json"), "utf8");
    spritesheet = new Uint8Array(await readFile(join(dir, "spritesheet.webp")).catch(() => readFile(join(dir, "sprite.webp"))));
  } catch {
    console.error(`Workflow TUI: no pet package found at ${dir}`);
    console.error(`Install one first, e.g.: npx petscodex install cat   (or npx petdex install <name>)`);
    process.exit(1);
  }
  const pet = parseCodexPet(petJson, spritesheet);
  const tempDir = await mkdtemp(join(tmpdir(), "workflow-pet-"));
  const write = async (name: string, state: string, cellWidth: number): Promise<string> => {
    const frames = codexPetStateFramesBraille(pet, state, cellWidth);
    const height = frames[0]!.split("\n").length;
    const path = join(tempDir, name);
    await writeFile(path, JSON.stringify({ frames, delays: frames.map(() => PET_FRAME_DELAY_MS), width: cellWidth, height }));
    return path;
  };
  return {
    home: await write("home-animation.json", "idle", PET_HOME_CELL_WIDTH),
    status: await write("status-animation.json", "idle", PET_STATUS_CELL_WIDTH),
  };
}

function runClineTui(clineRoot: string, cwd: string, bridgeUrl: string, bridgeToken: string, petAnimations: { home: string; status: string } | undefined): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "bun@1.3.13", "run", "--cwd", clineRoot, "cli", "--", "-i", "--cwd", cwd],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          WORKFLOW_CLINE_BRIDGE_URL: bridgeUrl,
          WORKFLOW_CLINE_BRIDGE_TOKEN: bridgeToken,
          WORKFLOW_TUI_MARK_B64: Buffer.from(WORKFLOW_MARK).toString("base64"),
          ...(petAnimations === undefined ? {} : { WORKFLOW_TUI_ANIMATION_PATH: petAnimations.home, WORKFLOW_TUI_STATUS_ANIMATION_PATH: petAnimations.status }),
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`Cline TUI terminated by ${signal}`));
      resolveExit(code ?? 1);
    });
  });
}
