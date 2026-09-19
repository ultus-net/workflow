# Runtime Containment

Workflow's process policy and runtime containment are separate gates. `WorkflowApplication.authorize()` decides whether a task may request process, credential, or host-network authority. `WorkflowContainedProcess` requires that authorization and then delegates execution to a `ProcessContainment` backend. An application `allow` does not mean containment was established.

Every `ContainedProcessResult` carries an `enforcement` marker so the two gates can never be conflated by type: `enforced` means the tested Bubblewrap boundary was established; `policy-only` means execution passed validation and authorization with **no isolation** (the non-Linux passthrough).

## Linux Bubblewrap Backend

`LinuxBubblewrapContainment` is the W019 enforced backend. It requires Linux and a working `/usr/bin/bwrap` by default. A different Bubblewrap executable path may be supplied explicitly. Before each execution the backend runs a sandbox probe; a missing or non-working backend rejects execution. Bubblewrap boundary-setup errors also reject rather than returning an `enforced` result.

The default sandbox exposes `/usr` read-only, compatibility links for `/bin`, `/sbin`, `/lib`, and `/lib64`, a read-only `/etc` for system user lookups (without exposing credentials), a new `/proc` inside a private PID namespace, and a minimal `/dev`. The PID namespace prevents a contained process from recovering hub/host environment data through `/proc/<host-pid>`. When the active Node runtime prefix or user binary paths (`~/.local/bin`, `~/.npm`) reside outside `/usr`, they are mounted read-only and provided on a clean, non-credential `PATH` so standard development tools (`node`, `npm`, `npx`, `bun`) run correctly inside containment. It does not inherit the parent filesystem root. `readablePaths` add explicit read-only binds and `writablePaths` add explicit writable binds. Before writable trees are mounted, the backend identifies regular-file inodes with links outside each tree, then applies read-only overlays for every affected top-level subtree after all writable binds. This prevents mutation through external hardlinks present during boundary construction while keeping unrelated workspace content writable; internal-only hardlinks remain writable. Callers must not concurrently change hardlink topology in granted writable trees while the sandbox is being constructed because the pre-mount scan is not an atomic filesystem snapshot. All grant paths and the executable path must be absolute.

Writable grants default to `read-write` (a full writable bind). The `read-write-no-delete` mount mode instead binds the granted tree read-only and re-binds every existing regular file writable, so in-place edits persist to the host while directory entries cannot be unlinked. Bubblewrap has no primitive that permits directory-entry writes while denying unlink, so blocking creation of new entries is the price of enforcing no-delete; that consequence is documented rather than hidden. The mode is a type-level variant of `ContainedProcessRequest.writableMountMode`, distinct from the backend `enforced` / `policy-only` isolation marker. A policy-only passthrough refuses `read-write-no-delete` rather than running it with deletion permitted.

The environment clears ambient credentials (`HOME`, `TOKEN`, `SECRET`, `KEY`). Supplying any `environment` entry through `WorkflowContainedProcess` automatically requires Workflow's default-withheld `credentials` capability. This deliberately treats all explicit environment injection as credential-bearing rather than trying to guess which variable names are sensitive.

Networking defaults to a new network namespace. Runtime tests inspect `/proc/net/dev` to prove host interfaces are absent on the supported Linux runtime. Requesting `network: "host"` through `WorkflowContainedProcess` automatically requires Workflow's default-withheld `network` capability.

## Example

```ts
const application = new WorkflowApplication(
  graph,
  host,
  [],
  new Set(["read", "mutation", "process"]),
);
const process = new WorkflowContainedProcess(application, new LinuxBubblewrapContainment());

const result = await process.execute(actionRequiringProcess, {
  executable: "/usr/bin/node",
  args: ["--version"],
});
```

Grant only the paths, environment, or host network that the operation actually needs. Production access is not a special promise made by this backend: keep production credentials absent and production endpoints unreachable unless separately authorized and constrained.

## Path Validation Ordering

Confinement resolves symlinks before the authoritative decision, never after it. Workflow resolves the workspace root and the candidate subject — including dangling in-workspace symlinks whose missing target is outside — to canonical paths, and the canonical result, not the lexical input, is what must fall inside the authorized workspace (`src/application/workflow.ts`). `WorkflowContainedProcess` passes `cwd` and every `readablePaths` / `writablePaths` grant through that same confinement check before the backend runs, so a symlink grant whose target escapes is denied with `WORKSPACE_PATH_DENIED`. The Bubblewrap backend separately resolves the executable's realpath before binding it, so a symlinked launcher is mounted at its real target.

Audit result (W063, 2026-09-19): the adversarial fixture — an in-workspace symlink pointing outside the workspace, offered as a read/write grant — is **non-exploitable**. W025 already fixed the application-layer symlink escape, so W063 records the non-exploitable audit result and keeps the ordering test as the durable guard instead of manufacturing a red-to-green fix. The residual, shared with the hardlink pre-mount scan, is that a concurrent actor swapping a symlink between authorization and the backend's bind-mount is not an atomic snapshot; callers must not mutate granted trees concurrently with sandbox construction.

## Guarantees And Non-Guarantees

An `enforced` result means the tested Bubblewrap invocation established the requested W019 boundary and launched the child. It does not mean the child succeeded; inspect `exitCode`, `stdout`, and `stderr` separately. A nonzero child exit is still a contained execution.

W019 does not claim macOS or Windows enforcement, VM isolation, protection against a hostile kernel/administrator, syscall filtering, resource limits, or confidential hiding of data deliberately granted through `readablePaths`. The backend exposes the system runtime under `/usr` and a minimal `/dev`; use a stronger container/VM policy when those surfaces are too broad for the threat model.

Run the Linux runtime checks with `npm run test:containment-runtime`. They require a working Bubblewrap installation and must fail rather than skip when that prerequisite is absent.
