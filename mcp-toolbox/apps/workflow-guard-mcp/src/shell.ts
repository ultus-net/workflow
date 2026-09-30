import { basename } from "node:path";

export function dynamicShellSyntaxIn(command: string): string | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (char === "'") { quote = quote === "'" ? undefined : quote ? quote : "'"; continue; }
    if (char === '"') { quote = quote === '"' ? undefined : quote ? quote : '"'; continue; }
    if (quote === "'") continue;
    if (char === "`" || (char === "$" && command[i + 1] === "(") || (!quote && (char === "<" || char === ">") && command[i + 1] === "(")) return "dynamic command/process substitution";
    if (char === "$" && /^(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\}|[0-9@*#?$!_-])/.test(command.slice(i + 1))) return "dynamic parameter expansion";
    if (!quote && (char === "\r" || /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(char))) return "ambiguous shell whitespace";
  }
  if (quote || escaped) return "malformed shell quoting";
  return undefined;
}

export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (char === "'" || char === '"') {
      if (!quote) quote = char;
      else if (quote === char) quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped) word += "\\";
  if (started) words.push(word);
  return words;
}

export function decodeShellEscapes(text: string): string {
  return text
    .replace(/\$'([^']*)'/g, "$1")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([0-3][0-7]{2})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

// Ported from upstream opencode-workflow-guard (#144/#152, W084): reduce a shell
// segment to the syntax that actually executes. Redirect targets are honored
// whether quoted or not — a quoted redirect target is still a real file, so
// the target quotes are removed first. Known pre-existing truncation (same in
// the pre-port regex and upstream's): a quoted target containing spaces
// analyzes only up to its first space, so this honors the target's FIRST
// space-delimited word, not arbitrary multi-word targets. SELF-CONTAINED
// quoted spans preceded by whitespace are command data and can never be shell
// redirects or operators. Quote spans glued to bare text are shell
// concatenation inside a single word (e.g. open''code.json) and are kept for
// the normalizer to flatten. A quoted span at segment start is NOT stripped:
// it can be a quoted command word ("opencode" auth) and must stay visible to
// verb patterns.
export function prepareRedirectResidue(segment: string): string {
  const withTargets = segment
    .replace(/(>>?)\s*'([^']*)'/g, "$1 $2")
    .replace(/(>>?)\s*"([^"]*)"/g, "$1 $2");
  return withTargets
    .replace(/\s'[^']*'(?=$|[\s)>;&|])/g, " ")
    .replace(/\s"[^"]*"(?=$|[\s)>;&|])/g, " ");
}

export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (char === "'" || char === '"') {
      if (!quote) quote = char;
      else if (quote === char) quote = undefined;
      current += char;
      continue;
    }
    if (!quote && /[\n|;&]/.test(char)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function executableIn(segment: string): string {
  return basename(unwrapShellWords(segment)[0] ?? "");
}

// P18 (a) class closure (2026-09-30): the sh-family interpreter vocabulary,
// SINGLE-SOURCED across the git wrapper lens, the shell interactive lens, and
// the boundary lane. Every POSIX-ish shell's name ends in `sh` — sh, bash,
// zsh, dash, ksh, ash (busybox's sh), mksh, pdksh, oksh, lksh, csh, tcsh,
// yash, posh, osh, rsh, xsh, xonsh, fish — so a basename ending in `sh` is
// classified as a shell rather than enumerating a family that never ends (the
// pre-P18 four-site copy had already drifted: two sites gained `xsh`, two did
// not, and ash/mksh/csh/tcsh/yash/posh/osh/rsh/xonsh/fish bypassed all four).
// Over-block tradeoff, deliberate and fail-closed: a NON-shell executable
// whose name ends in `sh` (e.g. `publish`, `flush`) that takes `-c <cmd>` is
// treated as a shell wrapper — observable only when the inner command would
// itself deny unwrapped, and never a weakening of an existing block.
export function isShFamilyInterpreter(name: string): boolean {
  return /sh$/i.test(name);
}

export function unwrapShellWords(command: string): string[] {
  return unwrapWords(shellWords(decodeShellEscapes(command.trim())));
}

// P18 (a/b): the word-level core of unwrapShellWords, callable on already
// tokenized words (the busybox applet args) so the nested wrapper words
// unwrap WITHOUT a string round trip — a quoted argv word stays one word and
// cannot pose as command syntax. The env -S branch splices the array, so
// callers pass their own.
export function unwrapWords(words: string[]): string[] {
  return unwrapWordsWithPrefix(words).command;
}

// P18 (d) review round: the wrapper/assignment PREFIX unwrapWords consumes is
// itself command position — `sudo GIT_DIR=/x echo …` names the same gitdir as
// the unprefixed form — so a scanner that must READ the consumed words (the
// gitdir spellings) needs the prefix, not only the surviving command. Exposing
// it here keeps the wrapper vocabulary single-sourced: unwrapWords is this
// function minus the prefix. `prefix` is the consumed leading slice (wrappers,
// their options, and assignments); `command` is the first real command word
// onward.
export function unwrapWordsWithPrefix(words: string[]): { prefix: string[]; command: string[] } {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (word === "command") {
      i += 1;
      while (words[i] === "-p") i += 1;
      if (words[i] === "--") i += 1;
      continue;
    }
    if (word === "exec") {
      i += 1;
      while (words[i]?.startsWith("-")) {
        const option = words[i++]!;
        if (option === "--") break;
        if (option === "-a" && i < words.length) i += 1;
      }
      continue;
    }
    if (word === "nohup") { i += 1; continue; }
    if (word === "nice") {
      i += 1;
      if (words[i] === "-n") i += 2;
      else if (words[i]?.startsWith("-n")) i += 1;
      continue;
    }
    if (word === "timeout") {
      i += 1;
      while (words[i]?.startsWith("-")) {
        const option = words[i++]!;
        if (["-k", "-s", "--signal", "--kill-after"].includes(option) && i < words.length) i += 1;
      }
      if (/^\d+[smhd]?$/.test(words[i] ?? "")) i += 1;
      continue;
    }
    if (word === "stdbuf") {
      i += 1;
      while (words[i]?.startsWith("-")) {
        const option = words[i++]!;
        if (["-i", "-o", "-e"].includes(option) && i < words.length) i += 1;
      }
      continue;
    }
    if (word === "time") {
      i += 1;
      while (words[i]?.startsWith("-")) i += 1;
      continue;
    }
    if (word === "sudo" || word === "doas") {
      i += 1;
      const valueOptions = new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-D", "--chdir"]);
      while (words[i]?.startsWith("-")) {
        const option = words[i++]!;
        if (valueOptions.has(option) && i < words.length) i += 1;
      }
      continue;
    }
    if (word === "env") {
      i += 1;
      while (i < words.length) {
        const option = words[i]!;
        if (option === "--") { i += 1; break; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) { i += 1; continue; }
        let splitValue: string | undefined;
        let consumed = 0;
        if (option.startsWith("-S") && option !== "-S") splitValue = option.slice(2);
        else if (option.startsWith("--split-string=")) splitValue = option.slice("--split-string=".length);
        else if ((option === "-S" || option === "--split-string") && i + 1 < words.length) {
          splitValue = words[i + 1]!;
          consumed = 1;
        }
        if (splitValue !== undefined) {
          words.splice(i, consumed + 1, ...shellWords(splitValue));
          continue;
        }
        if (["-u", "--unset", "--argv0", "-C", "--chdir"].includes(option)) { i += 2; continue; }
        if (option.startsWith("-")) { i += 1; continue; }
        break;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i += 1; continue; }
    break;
  }
  return { prefix: words.slice(0, i), command: words.slice(i).filter(Boolean) };
}
