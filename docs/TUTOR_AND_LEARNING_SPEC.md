# Workflow Pedagogical & Decision Architecture Specification
## Adaptive Language Tutor, LSP Tie-In, and Co-Architect Engine

## 1. Vision & Core Philosophy

### The Cognitive Offloading Hazard
As AI coding harnesses become more autonomous, software engineers face a critical hazard: **gradual deskilling, cognitive offloading, and alienation from their own codebase**. When an agent generates hundreds of lines of code, solves compiler errors behind the scenes, and claims completion through model narration, the human in the loop is reduced to an uninformed rubber stamp. Over time:
- The human loses the mental model of how the system works.
- Novices never build the foundational schemas of programming (syntax, types, memory, control flow).
- Experienced developers lose the ability to reason through architectural trade-offs, edge cases, and failure modes.

### The Objective
Transform Workflow from a passive safety harness into an **active pedagogical partner and collaborative co-architect**. The system must keep a smart, informed human in the loop by:
1. Ensuring the human continually learns and understands the code being proposed.
2. Explaining architectural decisions, rejected alternatives, and trade-offs before consequential mutations occur.
3. Grounding language learning and type semantics in **deterministic compiler truth via Language Server Protocol (LSP)** rather than LLM guesswork.
4. Adaptively tailoring explanations and questions to the user's observed mastery, from complete beginner to systems architect.

---

## 2. The Collaborative Spectrum: Five Operating Modes

Workflow supports a dynamic spectrum of collaborative modes, switchable at any time via the TUI (e.g., `Tab` or `m` hotkey) or session configuration.

```text
[ Learn to Code ] -> [ Socratic Tutor ] -> [ Co-Architect ] -> [ Walkthrough ] -> [ Autonomous ]
  (Foundations)        (Questioning)        (Trade-offs)        (Inspection)       (Fast-track)
```

| Mode | Target User | Focus | Interaction Style | Mutation Gating |
| :--- | :--- | :--- | :--- | :--- |
| **1. Learn to Code** | Beginners / new language learners | Fundamentals: syntax, types, control flow, functions, errors | Scaffolding, PRIMM (Predict-Run-Investigate-Modify-Make), interactive gap-filling | Pauses before and during edits; user writes or verifies critical lines |
| **2. Socratic Tutor** | Intermediate devs building systems | Concepts: patterns, concurrency, memory, OS primitives | Socratic questioning at non-trivial design forks and debugging breakthroughs | Gated on answering or discussing candidate learning checkpoints |
| **3. Co-Architect** | Senior engineers / tech leads | Strategy: Architecture Decision Records (ADRs), trade-offs | Structured Decision Briefs (chosen vs. alternatives, blast radius) | Gated on explicit human approval of architectural approach |
| **4. Code Walkthrough** | Code reviewers / auditors | Transparency: diff invariants, edge cases, and TSDoc | Post-mutation tour explaining *why* invariants hold before verification | Requires human inspection before task moves to `VERIFYING` |
| **5. Autonomous** | Routine / mechanical tasks | Speed: boilerplate, mechanical refactoring, syntax cleanups | Minimal interruptions; standard Workflow authorization and evidence | Normal Workflow policy authorization |

---

## 3. Language Server Protocol (LSP) Tie-In: Compiler as Pedagogical Partner

An LLM tutor that guesses types or invents error explanations leads to confusion. Tying the tutor directly to an LSP client provides **unassailable compiler ground truth**.

```text
+-------------------------------------------------------------------------+
|                              Workflow TUI                               |
+-------------------------------------------------------------------------+
        |                                                 ^
        v                                                 |
+----------------------+                       +-----------------------+
|  Pedagogical Engine  | <-------------------> |  LSP Client Adapter   |
| (Learning & Decision)|                       |  (stdio / JSON-RPC)   |
+----------------------+                       +-----------------------+
        |                                                 |
        | Proposes Checkpoints                            | Hover / Diagnostics
        v                                                 v
+----------------------+                       +-----------------------+
| Workflow Application |                       | Target Language Server|
| (Kernel + Evidence)  |                       | (typescript, rust, py)|
+----------------------+                       +-----------------------+
```

### 3.1 Teachable Moments from Compiler Diagnostics (`publishDiagnostics`)
When a compiler diagnostic occurs (e.g., TypeScript `TS2345`, Rust `E0382`, Python `Pylance(reportGeneralTypeIssues)`):
1. **Raw Diagnostic Capture:** The LSP client notifies the Pedagogical Engine of diagnostics emitted for edited files.
2. **Pedagogical Deconstruction:** The engine breaks down the diagnostic into three parts:
   - **The Plain-English Diagnosis:** What the compiler detected (e.g., "Function `fetchUser` expects a non-null `userId`, but `userId` is typed `string | undefined`").
   - **The Underlying Rationale:** Why the language enforces this rule (e.g., "Runtime null-pointer prevention: JavaScript would throw `TypeError: Cannot read properties of undefined`").
   - **Socratic Guidance (Mode-calibrated):**
     * *In Learn to Code:* "What construct can we use to guarantee `userId` is present before calling the function?"
     * *In Socratic Tutor:* "Compare narrowing with a type guard vs. asserting with `!`. Why is narrowing safer in asynchronous callbacks?"
3. **Resolution Observation (pedagogy scope):**
   - The user/agent applies a fix; LSP reports `0` diagnostics for the target path.
   - **Current implementation:** the LSP adapter normalizes diagnostics into the pedagogy `DiagnosticInput` shape only (message/code/position), which feeds tutor lessons. Diagnostics are **not** yet admitted as Workflow `Evidence`, and there is no `lsp:diagnostics:clean` evidence flow; binding diagnostics to mutation epochs as task evidence is future work.

### 3.2 Symbol & Signature Deep-Dives (`textDocument/hover` & `inlayHint`)
- In **Learn to Code** and **Socratic Tutor** modes, hovering or asking about a symbol triggers an enriched explanation:
  * Raw evaluated type signature from LSP.
  * Inlay parameter hints and implicit return types.
  * Plain-English mental model breakdown (e.g., why `Promise.all` fails fast while `Promise.allSettled` accumulates results).

### 3.3 Definition & Architecture Tracing (`textDocument/definition` & `references`)
- When learning an existing codebase or third-party library, the tutor uses definition hops to teach interface-implementation separation and dependency inversion.

---

## 4. Adaptive Learner Engine & Knowledge Graph

The tutor must not feel like an annoying popup quiz. It uses an **evidence-based Bayesian Knowledge Tracing (BKT)** model that learns what the operator already knows and respects their cognitive flow.

### 4.1 Concept Hierarchy
Concepts are organized into a tiered knowledge graph:

```text
Foundations (Learn to Code):
  ├── syntax:variables (const vs let, scope)
  ├── syntax:control-flow (if/else, loops, pattern matching)
  ├── types:primitive-vs-object (primitives, references, mutability)
  ├── types:null-safety (optional chaining, nullish coalescing, type narrowing)
  ├── functions:signatures (parameters, return types, pure functions)
  ├── async:promises (event loop, async/await, microtask queue)
  └── errors:handling (try/catch, error types, fail-fast)

Intermediate / Systems (Full Tutor):
  ├── architecture:dependency-inversion (ports & adapters, mocks vs fakes)
  ├── concurrency:atomic-operations (mutex, race conditions, file locks)
  ├── state:monotonic-epochs (cache invalidation, generation counters)
  ├── os:process-isolation (namespaces, capabilities, Bubblewrap)
  ├── fs:atomic-swaps (temporary files + renameSync, crash safety)
  └── testing:invariants (property testing, boundary conditions, regressions)
```

### 4.2 Stage Progression
For every concept, the learner profile tracks progression monotonically:
- `exposed`: Concept has been introduced and explained.
- `developing`: Learner has answered guided prompts or questions with partial assistance.
- `demonstrated`: Learner correctly identified trade-offs or answered Socratic checkpoints without hints.
- `independent`: Learner initiated the design pattern without prompting.
- `critique`: Learner critically reviewed or rejected a bad proposal (implementation-specific fifth stage).

Struggle is recorded as `needs-reinforcement` **evidence** (not a stage): the concept's stage is preserved while the evidence log marks the gap, which `selectLearningOpportunity` consumes.

### 4.3 Fatigue Prevention & Intervention Budgeting
- **Intervention Budget:** Maximum 2-3 Socratic interruptions per coding task in `Socratic Tutor` mode (unlimited in `Learn to Code` mode, 0 in `Autonomous` mode).
- **Prerequisite Checking:** *Not implemented.* The code has no concept graph; the §4.1 hierarchy is an informal label taxonomy, and concepts are addressed individually. Introducing a structured prerequisite check is deferred until concept data requires it.
- **Mastery Suppression:** Once a concept is `independent`, the agent will never quiz the user on it again unless the user explicitly asks for a review.

### 4.4 Local Persistence (`~/.local/share/workflow/learner-profile.json`)
The profile persists across sessions in a versioned, locked JSON store, completely decoupled from any specific git repository.

---

## 5. Tool & Communication Contracts

Of the three tools below, only `learning_checkpoint` and `decision_checkpoint`
exist — defined in the vendored `mcp-toolbox/apps/learning-mcp` server and
gated Workflow-side by `src/pedagogy/checkpoints.ts`. `symbol_explain` is **not
implemented anywhere**; symbol inspection is served by `code-intelligence-mcp`
and the LSP adapter's `hover` client. The interfaces below are the target
shapes; the implemented `LearningOpportunity`/`DecisionBrief` records (see
`src/pedagogy/contracts.ts`) map the first two, with `chosenOption` in place of
`proposedChoice` and `new-concept` among the `foundations|design|debugging`
type values in place of a `systems` category.

### 5.1 `decision_checkpoint` (Co-Architect Tool)
Called by the agent before committing to an architectural approach:
```typescript
export interface DecisionCheckpointInput {
  readonly title: string;
  readonly context: string;
  readonly proposedChoice: {
    readonly name: string;
    readonly rationale: string;
    readonly blastRadius: "low" | "medium" | "high";
  };
  readonly rejectedAlternatives: readonly {
    readonly name: string;
    readonly drawback: string;
  }[];
  readonly tradeoffs: {
    readonly benefits: readonly string[];
    readonly liabilities: readonly string[];
  };
}
```

### 5.2 `learning_checkpoint` (Socratic Tutor Tool)
Called by the agent when encountering a teachable engineering moment:
```typescript
export interface LearningCheckpointInput {
  readonly concept: string;
  readonly category: "foundations" | "design" | "debugging" | "systems";
  readonly relevance: number;   // 0.0 - 1.0
  readonly consequence: number; // 0.0 - 1.0
  readonly teachableInsight: string;
  readonly socraticQuestion: string;
  readonly candidateAnswers?: readonly {
    readonly label: string;
    readonly description: string;
  }[];
}
```

### 5.3 `symbol_explain` (LSP Symbol Walkthrough Tool)
Called on demand or during "Learn to Code" mode:
```typescript
export interface SymbolExplainInput {
  readonly filePath: string;
  readonly symbol: string;
  readonly line: number;
  readonly character: number;
}

export interface SymbolExplainOutput {
  readonly symbol: string;
  readonly lspTypeSignature: string;
  readonly lspDocumentation?: string;
  readonly plainEnglishExplanation: string;
  readonly languageMechanic: string;
  readonly commonPitfalls: readonly string[];
}
```

---

## 6. Hybrid System Architecture: mcp-toolbox vs. Workflow Repositories

To preserve the separation of concerns and avoid bloated monolithic repos, responsibilities are cleanly divided across **mcp-toolbox** and **Workflow**:

```text
+--------------------------------------------------------------------------+
|                            mcp-toolbox Repo                              |
|           (Capabilities, Language Intelligence & Learner State)          |
+--------------------------------------------------------------------------+
|  • code-intelligence-mcp (TypeScript Language Service / LSP backend)     |
|    - Diagnostics, definitions, references, hover, AST symbols           |
|    - Diagnostic-to-pedagogy translator (TS2345 -> plain English model)   |
|    - Symbol deep-dive tool (types, signatures, mental model)             |
|  • learning-mcp (Learner profile, BKT mastery tracking, concept graph)   |
|    - Multi-process locked JSON store (~/.local/share/workflow/)          |
|    - Interaction picker (chooseInteraction) & study session state       |
+--------------------------------------------------------------------------+
                                    |  JSON-RPC (stdio / MCP)
                                    v
+--------------------------------------------------------------------------+
|                             Workflow Repo                                |
|                  (Authority, Task Gates & TUI Display)                   |
+--------------------------------------------------------------------------+
|  • Policy & Kernel: Enforces gating (e.g. Co-Architect approval before   |
|    mutation; diagnostic-clean evidence before VERIFIED)                  |
|  • MCP Boundary (W006/W010): Normalizes MCP diagnostics into canonical   |
|    Evidence objects bound to mutation epochs                             |
|  • TUI & Session (W028/W036): Mode switcher (Tab/m), Socratic drawers,   |
|    Decision Brief cards, and symbol walkthrough shortcuts (?)            |
+--------------------------------------------------------------------------+
```

### Why this division matters:
1. **Tool Portability:** `code-intelligence-mcp` and `learning-mcp` can be consumed by any AI agent environment (Cline, OpenCode, Claude Desktop, Cursor) as standard MCP servers.
2. **Process Isolation:** The compiler Language Service and AST workers run out-of-process in their own Node.js worker, preventing memory pressure on the Workflow process.
3. **Strict Invariant Authority:** Workflow retains sole authority over what is authorized to mutate and what constitutes passing evidence. An MCP server provides observations and capabilities; Workflow enforces rules.

---

## 7. Integration with Workflow's Core Invariant

Workflow's core invariant remains preserved:
```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

1. **Kernel Purity (`src/kernel/`):**
   - The kernel remains 100% deterministic, without LLM, LSP, or UI dependencies.
   - Tasks may declare prerequisite evidence types: e.g., `decision:approved` or `evidence:lsp:clean`.
2. **Application Boundary (`src/application/`):**
   - `WorkflowApplication` coordinates mode state, manages the `LearnerProfileStore`, and gates state transitions.
   - `WorkflowCodingSession` emits pedagogical events (`decision-brief`, `tutor-checkpoint`, `diagnostic-lesson`) over the event stream.
3. **LSP Port (`src/adapters/lsp.ts`):**
   - Implements a host-neutral JSON-RPC client over stdio.
   - Normalizes diagnostics into pedagogy-oriented diagnostic objects (`DiagnosticInput`). **Epoch-bound `Evidence` normalization is not implemented** (see W032).
4. **TUI Presentation (`src/ui/tui.tsx`):**
   - Status bar shows current mode: `[Mode: Socratic Tutor (m to switch)]`.
   - Dedicated interactive panel displays Decision Briefs, Socratic Questions, and LSP Diagnostic Explanations.
   - Keyboard shortcuts:
     * `m`: Cycle mode (Learn to Code -> Socratic Tutor -> Co-Architect -> Walkthrough -> Autonomous).
     * `p`: Open Learner Profile & Concept Mastery dashboard.
     * `?`: Inspect symbol under cursor via LSP + Tutor.

---

## 8. Implementation Roadmap (Phases & Tasks)

### W032: LSP Client Adapter & Diagnostic Evidence
- ~~Implement host-neutral stdio JSON-RPC LSP client in `src/adapters/lsp.ts`.~~ **(done)**
- ~~Normalize `publishDiagnostics` into pedagogy diagnostic inputs with unit tests.~~ **(done — `normalizeDiagnostics` into `DiagnosticInput`; tests cover framing/normalization against one fake server)**
- **Outstanding:** promote diagnostics to epoch-bound `Evidence` (`lsp:diagnostics:clean` admission) — not implemented; TypeScript/Rust/Python-format parsing tests are not delivered (single fake server fixture).

### W033: Adaptive Learner Engine & Profile Store
- ~~Implement `src/pedagogy/learner-profile.ts` with local locked JSON persistence.~~ **(done)**
- ~~Implement monotonic concept stages (`exposed/developing/demonstrated/independent/critique`), mastery suppression, and intervention budgeting per concept record.~~ **(done)**
- **Outstanding:** a structured concept *knowledge graph* (prerequisite edges) and a Bayesian mastery tracker are not implemented; concepts are addressed individually (see §4.3).

### W034: Socratic Tutor & Co-Architect Host Seams
- ~~Implement `learning_checkpoint` and `decision_checkpoint` tool definitions (vendored `learning-mcp`).~~ **(done — Workflow gating runs through `src/pedagogy/checkpoints.ts`)**
- **Outstanding:** `symbol_explain` has no tool definition anywhere (§5).
- Integrate tool interception in `ClineHostAdapter` and `WorkflowApplication.authorize()`. **(done via checkpoint gate: `WorkflowApplication.setPedagogyGate`)**
- Add test suites covering gating on pending checkpoints. **(done)**

### W035: "Learn to Code" Fundamentals & Diagnostic Translator
- Build the diagnostic-to-pedagogy translation engine (mapping compiler errors to plain-English mental models).
- Add PRIMM and fill-in-the-gap interaction templates for novice learners.

### W036: TUI Pedagogical Surface & Mode Selector
- Add mode switching (`m`) and status indicator to the Ink TUI.
- Add interactive Decision Brief & Socratic Question drawers with keyboard navigation.
- Add Learner Profile mastery view.
