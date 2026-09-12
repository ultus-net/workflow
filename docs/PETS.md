# Petdex / Codex Pets

Workflow can load and render [Petdex](https://petdex.dev) pets (also known as
Codex desktop pets) in the terminal. A pet package is a directory containing
`pet.json` and a lossless WebP `spritesheet.webp` laid out as 8 columns of
192x208 frames; each row is an animation state (`idle`, `running-right`,
`running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, `review`).

## Library

- `src/ui/pets/webp-lossless.ts` — pure TypeScript VP8L (lossless WebP)
  decoder implementing RFC 9649 section 3: RIFF container scan, bit-reversed
  canonical prefix codes, meta prefix codes, color cache, LZ77 backward
  references, and all four inverse transforms (predictor, cross-color,
  subtract-green, color indexing with delta-encoded palette). Lossy VP8 and
  extended VP8X containers are rejected with explicit errors.
- `src/ui/pets/codex-pet.ts` — `parseCodexPet(petJson, spritesheetBytes)`
  validates the manifest, decodes the spritesheet, and slices it into
  per-state frame arrays.
- `src/ui/pets/codex-pet-renderer.ts` — renders frames as ANSI truecolor
  half-block art (reusing `rgbaToAnsiHalfBlocks`) at a chosen cell width and
  maps Workflow activity signals to pet states.

Spritesheets are untrusted external data: header sizes are validated before
allocation, backward references are bounds-checked, and malformed streams fail
closed with `Error`.

## CLI

```sh
npm run pets -- ~/.codex/pets/cat            # idle state
npm run pets -- ~/.codex/pets/cat waiting 30 48
```

## TUI home

`npm run tui -- --pet ~/.codex/pets/cat` renders the pet's idle animation on
the patched Cline home view. The launcher converts the pet to the bounded
animation JSON format already consumed by `WORKFLOW_TUI_ANIMATION_PATH`
(`tracked-robot.tsx` in the Cline patch) and passes it to the child process.
Without `--pet`, the home view shows no artwork.
