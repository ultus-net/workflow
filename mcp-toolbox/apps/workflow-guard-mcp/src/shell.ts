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

export function unwrapShellWords(command: string): string[] {
  const words = shellWords(decodeShellEscapes(command.trim()));
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
  return words.slice(i).filter(Boolean);
}
