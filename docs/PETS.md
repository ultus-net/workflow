# Petdex / Codex Pets (currently disabled)

> **Status: disabled.** The TUI wiring (`npm run tui -- --pet <dir>`) was removed
> after evaluation showed terminal-cell rendering cannot reproduce the artwork
> well enough. The library (`webp-lossless`, `codex-pet`, `codex-pet-renderer`,
> `codex-pet-braille`) and the `npm run pets` CLI remain; the Cline patch is
> reduced to the authorization-bridge hook only.

Workflow can load and render [Petdex](https://petdex.dev) pets (also known as
Codex desktop pets) in the terminal. A pet package is a directory containing
`pet.json` and a lossless WebP `spritesheet.webp` laid out as 8 columns of
192x208 frames.

## Findings from the disabled TUI integration

- Lossless WebP decoding works bit-exactly (custom TS VP8L decoder, RFC 9649 §3).
- Half-block ANSI rendering was colorful but visibly downsampled at the
  frame's 192x208 source; cropping transparent margins helped but did not
  remove the pixelation.
- Braille (2x4 sub-dots per cell) gave crisp edges but sparse, washed-out
  interiors; a hybrid (solid `█` fill for full cells, braille only at edges)
  was the best variant and still mediocre.
- The real resolution limit is the terminal cell grid; if re-enabled, larger
  renders or non-SGR image protocols (Kitty/iTerm inline images) would be
  the only meaningful improvements.

## Library

- `src/ui/pets/webp-lossless.ts` — pure TypeScript VP8L (lossless WebP)
  decoder implementing RFC 9649 section 3.
- `src/ui/pets/codex-pet.ts` — pet.json manifest validation and grid slicing.
- `src/ui/pets/codex-pet-renderer.ts` — half-block ANSI rendering.
- `src/ui/pets/codex-pet-braille.ts` — braille/full-block hybrid rendering.

## CLI (still works)

```sh
npm run pets -- ~/.codex/pets/cat idle 32 24
```

If the TUI integration is re-enabled, it should reuse the bounded
`WORKFLOW_TUI_ANIMATION_PATH` JSON hook the patch used to accept; the original
pattern is archived in git history (pre-disable commits on `pets/codex-pets`).
