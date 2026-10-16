# W211: diagram format policy knob (`illustration.diagramFormat`)

Status: implemented, pending CI. Mechanism only; the requirement stays partly
open.

## Problem

The style packs ask the model for a fenced ```` ```text ```` diagram where a
section describes structure, flow, or a comparison (`src/assistant/style/pack.ts`,
`diagramRule`). That is ASCII art drawn from a fixed glyph set, not a rendered
diagram. The planning doc records the gap and the open questions
(`augur/docs/planning-questions.md:1098-1120`, "Diagram output: visual diagram
trees on request").

This slice delivers **one** decision among the open set: the pack-setter is the
"on request" mechanism, and Mermaid is the format. It builds the knob and nothing
downstream.

## What shipped

### The knob

`StylePackSchema.illustration.diagramFormat` is `z.enum(["text", "mermaid"])`
defaulting to `"text"` (`src/assistant/style/pack.ts`). The existing `diagram`
toggle (`off | optional | required`) is unchanged and keeps its meaning.

### The prompt rule

`buildSystemPrompt` picks the diagram sentence from the format:

- `text` -> the exact string every pack emits today, held in `textDiagramRule`.
  This is byte-identical: the three shipped packs (`notes`, `essay`, `hybrid`)
  produce the same system prompt as before.
- `mermaid` -> `mermaidDiagramRule`, which asks for a fenced ```` ```mermaid ````
  block, valid Mermaid source only, a `flowchart`/`graph` for structure and flow,
  and a hierarchy/nested form for trees.

Both prompts are built with `+` concatenation, no template literals, per the
assistant-source convention. `diagram: "off"` still emits `Do not add diagrams.`
for either format.

### The linter

`lint` derives the fence from the pack: `diagramFormat === "mermaid"` matches a
```` ```mermaid ```` block, otherwise ```` ```text ```` exactly as before. The
regex is built from the enum, never from pack-supplied free text, so a pack
cannot inject a pattern. The `diagram-required` finding message now names the
pack's own fence (`\`\`\`mermaid diagram` vs `\`\`\`text diagram`). The
`diagram-per-section` rule reads the same `hasDiagram` value.

## Default is unchanged (the load-bearing property)

Every existing pack leaves `diagramFormat` unset, so it resolves to `"text"`, and
the `text` branch is the previous code path verbatim. Evidence:

- Prompt diff: dumping `buildSystemPrompt` for `notes`/`essay`/`hybrid` from
  commit `6dea4684` and from this branch is byte-identical (`diff` -> IDENTICAL).
- The `text` diagram rule literal is compared equal to the base revision's
  literal (`base == new text rule: True`).
- `test/diagram-format.test.ts` pins the exact current ```` ```text ```` prompt
  string and asserts a default pack never mentions mermaid.

No pack YAML is modified, so the shipped packs stay byte-identical.

## Explicit deferrals (left open)

The planning doc's open questions (`augur/docs/planning-questions.md:1106-1120`)
are only partly closed:

- **Format (`:1108-1109`).** Mermaid chosen as the knob's second value. Graphviz/
  DOT and rendered-image formats are NOT built. A third enum value is the seam.
- **Surface rendering (`:1110-1114`).** NOT resolved. This emits Mermaid source
  text only; augur renders nothing. Discord does not render Mermaid and LibreChat
  may, so a format that renders on one surface still forces a fallback. Verify
  against the deployed LibreChat before a pack opts in.
- **"On request" semantics (`:1115-1117`).** The **pack setting** variant is
  built. The per-run flag (`--diagrams mermaid`) and the in-conversation ask
  ("draw me a tree of this") are NOT built. The in-conversation ask needs the
  assistant loop; this slice touches the tutor module only.
- **Trees as first class (`:1118-1120`).** NOT resolved. The mermaid prompt
  mentions a hierarchy form for trees but does not treat tree diagrams as a
  distinct first-class output, and no tree-specific linting exists.

## Tests

`test/diagram-format.test.ts` (registered in `test/ci-suites.txt`, sorted):

- the default `diagramFormat` is `text`;
- a default pack emits the exact current ```` ```text ```` prompt (regression
  pin, no mermaid mention);
- every shipped pack stays on `text`, byte-identical;
- a mermaid pack asks for a ```` ```mermaid ```` block with a valid-Mermaid
  instruction and no ```` ```text ```` ask;
- `diagram: "off"` suppresses the rule for either format;
- a `text` pack lints a ```` ```text ```` diagram as before and rejects a
  ```` ```mermaid ```` block;
- a `mermaid` pack lints a ```` ```mermaid ```` block, rejects a ```` ```text ````
  block, and reports absence when `diagram: "required"`;
- the `diagram-required` finding names the pack's own fence.

## Non-goals

- No new dependency: no Mermaid renderer, no Graphviz. Source text only.
- No change to the gateway, the assistant loop, or any surface renderer.
- No change to any shipped `assets/augur/styles/*/style.yaml`.
