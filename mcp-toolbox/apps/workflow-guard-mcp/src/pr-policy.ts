import { splitShellSegments, unwrapShellWords } from "./shell.js";

function prShellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | "ansi" | undefined;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (!quote && char === "$" && command[i + 1] === "'") { quote = "ansi"; started = true; i += 1; continue; }
    if (quote === "ansi") {
      if (char === "'") { quote = undefined; continue; }
      if (char === "\\" && i + 1 < command.length) {
        const next = command[++i];
        word += next === "n" ? "\n" : next === "r" ? "\r" : next === "\\" ? "\\" : `\\${next}`;
        continue;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      if (!quote) quote = char; else if (quote === char) quote = undefined; else word += char;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[++i];
      if (next !== "\n") {
        if (quote === '"' && next && !["$", "`", '"', "\\"].includes(next)) word += "\\";
        word += next ?? "\\";
      }
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
  if (started) words.push(word);
  return words;
}

function decodeEnvSplitLineBreaks(value: string): string {
  let decoded = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\\" || i + 1 >= value.length) { decoded += value[i]; continue; }
    const next = value[++i];
    if (next === "n") decoded += "\n";
    else if (next === "r") decoded += "\r";
    else if (next === "\\") decoded += "\\";
    else decoded += `\\${next}`;
  }
  return decoded;
}

function isPrCreateWords(words: string[]): boolean {
  if (words[0] === "gh") {
    let i = 1;
    while (["-R", "--repo", "--hostname"].includes(words[i] ?? "")) i += 2;
    while (/^(?:--repo|--hostname)=/.test(words[i] ?? "")) i += 1;
    return words[i] === "pr" && words[i + 1] === "create";
  }
  if (words[0] === "az") {
    const valueOptions = new Set(["--org", "--organization", "--project", "--subscription", "--output", "-o", "--query"]);
    let i = 1;
    while (words[i]?.startsWith("-")) {
      const option = words[i++]!;
      if (!option.includes("=") && valueOptions.has(option)) i += 1;
    }
    return words[i] === "repos" && words[i + 1] === "pr" && words[i + 2] === "create";
  }
  return false;
}

export function hasPrCreateInvocation(command: string): boolean {
  return splitShellSegments(command).some((segment) => isPrCreateWords(unwrapShellWords(segment)));
}

function bodyHasLiteralLineBreakEscapes(segment: string): boolean {
  let words = prShellWords(segment);
  const envIndex = words.indexOf("env");
  if (envIndex >= 0) {
    const splitIndex = words.findIndex((word, index) => index > envIndex && (word === "-S" || word === "--split-string"));
    const inlineSplitIndex = words.findIndex((word, index) => index > envIndex && (word.startsWith("-S") && word !== "-S" || word.startsWith("--split-string=")));
    if (splitIndex >= 0 && words[splitIndex + 1]) words = prShellWords(decodeEnvSplitLineBreaks(words[splitIndex + 1]!));
    else if (inlineSplitIndex >= 0) {
      const option = words[inlineSplitIndex]!;
      words = prShellWords(decodeEnvSplitLineBreaks(option.startsWith("--split-string=") ? option.slice("--split-string=".length) : option.slice(2)));
    }
  }
  const cliIndex = words.findIndex((word) => word === "gh" || word === "az");
  if (cliIndex < 0 || !isPrCreateWords(words.slice(cliIndex))) return false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    let body: string | undefined;
    if (["--body", "-b", "--description", "-d"].includes(word)) body = words[i + 1];
    else if (/^(?:--body|--description)=/.test(word)) body = word.slice(word.indexOf("=") + 1);
    if (body && /\\[nr](?:\\[nr]|(?=\s*[-*#]))/.test(body)) return true;
  }
  return false;
}

export function checkPrCreatePreflight(command: string): { policy: string; decision: "deny"; reason: string } | undefined {
  if (!hasPrCreateInvocation(command)) return undefined;
  if (splitShellSegments(command).some(bodyHasLiteralLineBreakEscapes)) {
    return {
      decision: "deny",
      policy: "pr-preflight",
      reason: "PR description contains literal \\n/\\r escapes that will render as text; use real newlines or a body/description file instead.",
    };
  }
  return undefined;
}
