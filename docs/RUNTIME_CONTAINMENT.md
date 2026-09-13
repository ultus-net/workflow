# Runtime Containment

Workflow's process policy and runtime containment are separate gates. `WorkflowApplication.authorize()` decides whether a task may request process, credential, or host-network authority. `WorkflowContainedProcess` requires that authorization and then delegates execution to a `ProcessContainment` backend. An application `allow` does not mean containment was established.

Every `ContainedProcessResult` carries an `enforcement` marker so the two gates can never be conflated by type: `enforced` means the tested Bubblewrap boundary was established; `policy-only` means execution passed validation and authorization with **no isolation** (the non-Linux passthrough).

## Linux Bubblewrap Backend

`LinuxBubblewrapContainment` is the W019 enforced backend. It requires Linux and a working `/usr/bin/bwrap` by default. A different Bubblewrap executable path may be supplied explicitly. Before each execution the backend runs a sandbox probe; a missing or non-working backend rejects execution. Bubblewrap boundary-setup errors also reject rather than returning an `enforced` result.

The default sandbox exposes `/usr` read-only, compatibility links for `/bin`, `/sbin`, `/lib`, and `/lib64`, a read-only `/etc` for system user lookups (without exposing credentials), a new `/proc`, and a minimal `/dev`. When the active Node runtime prefix or user binary paths (`~/.local/bin`, `~/.npm`) reside outside `/usr`, they are mounted read-only and provided on a clean, non-credential `PATH` so standard development tools (`node`, `npm`, `npx`, `bun`) run correctly inside containment. It does not inherit the parent filesystem root. `readablePaths` add explicit read-only binds and `writablePaths` add explicit writable binds. All grant paths and the executable path must be absolute.

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

## Guarantees And Non-Guarantees

An `enforced` result means the tested Bubblewrap invocation established the requested W019 boundary and launched the child. It does not mean the child succeeded; inspect `exitCode`, `stdout`, and `stderr` separately. A nonzero child exit is still a contained execution.

W019 does not claim macOS or Windows enforcement, VM isolation, protection against a hostile kernel/administrator, syscall filtering, resource limits, or confidential hiding of data deliberately granted through `readablePaths`. The backend exposes the system runtime under `/usr` and a minimal `/dev`; use a stronger container/VM policy when those surfaces are too broad for the threat model.

Run the Linux runtime checks with `npm run test:containment-runtime`. They require a working Bubblewrap installation and must fail rather than skip when that prerequisite is absent.
