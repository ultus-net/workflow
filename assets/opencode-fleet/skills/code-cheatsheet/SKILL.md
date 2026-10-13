---
name: code-cheatsheet
description: Guides agents through building a labeled-component cheat sheet from code in a language the user is learning, persisting it to a cumulative per-language library that maps each construct to languages the user already knows. Use when the user asks to cheat sheet, break down, or label code, is visibly ramping up in a language new to them, or asks to expand or review the cheatsheet library.
---

# Code Cheatsheet

## Overview

Turns unfamiliar code into a labeled cheat sheet anchored to languages the
user already knows, persisted to a cumulative library so coverage compounds
instead of restarting. The library doubles as the label registry for the
machine-global teaching feed.

## When to Use

- The user asks for a cheat sheet, breakdown, or labeled explanation of code.
- The user is working in a language they are clearly still learning.
- The teaching feed flagged a recurring construct family that has no sheet.
- When NOT to use: the user wants a one-off answer with no lasting artifact,
  or the library already covers the construct (link the sheet instead).

## The Workflow

1.  **Target the input.** Identify the target language and the code piece
    (a snippet in the request or a file path). Read the code first.
2.  **Anchor to known languages.** Read `~/.local/share/cheatsheets/profile.md`
    if it exists; it records the languages the user is fluent in. If absent
    or stale, ask once and write the answer there before proceeding.
3.  **Check existing coverage.** List `~/.local/share/cheatsheets/<language>/`.
    Spend depth on constructs not yet labeled; link covered ones.
4.  **Decompose into labeled components.** Assign each distinct construct a
    short stable label (`PATTERN-MATCH`, `TRAIT-BOUND`, `AWAIT`). Reuse the
    library's existing label for a known construct; never mint synonyms.
5.  **Verify before labeling.** Confirm non-obvious syntax and API claims
    against official docs or a compiler/typechecker before they enter the
    sheet. A wrong entry poisons every later run that reuses the label.
6.  **Write the sheet** to `~/.local/share/cheatsheets/<language>/<topic>.md`
    using `template.md` beside this file. If the file exists, merge: keep
    prior entries, add new labels, correct what the code contradicts.
7.  **Report back.** Reply with the sheet path, new labels, reused labels,
    and one drill from the sheet. Link the sheet; never re-paste it.

## Sheet Rules

-   Every component row carries: label, target-language name, what it does,
    anchor equivalent, one gotcha. A row missing its anchor mapping is
    unfinished.
-   The skeleton compiles as written and carries inline callouts
    (`/* <- LABEL */`). Interactions (ownership, control flow, lifetimes)
    get a fenced diagram, not prose.
-   Gotchas come from the code at hand or verified docs, never folklore.
-   End with three drills that force recall of the new labels without the
    sheet open.

## Common Rationalizations

-   "It is simple syntax; verification is overkill." Simple syntax is where
    hallucinated APIs and wrong precedence slip in. Verify anyway.
-   "The user just wants an explanation, not a file." An unpersisted
    breakdown evaporates and the next session re-teaches it. Persist, then
    link.
-   "A fresh label reads better here." Synonyms fragment the registry; the
    next run cannot find the construct it already labeled. Reuse.
-   "profile.md is missing; assume the anchors." Guessed anchors defeat the
    mapping and teach the wrong comparisons. Ask once, then record.

## Red Flags

-   The reply narrates the code line by line instead of indexing components.
-   Two labels exist for one construct, or a label changes meaning between
    sheets.
-   An existing sheet was overwritten instead of merged.
-   Syntax or API claims entered the sheet without a doc or compiler check.

## Verification

-   The skeleton was compiled or typechecked; the command and its exit
    status are noted in the reply.
-   Every component row has an anchor equivalent; labels match those already
    in `~/.local/share/cheatsheets/` (grep before writing).
-   The reply names the sheet path and separates new labels from reused ones.