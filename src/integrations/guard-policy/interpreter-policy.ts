import { checkProtectedPath, checkSecretPath } from "./path-policy.js";
import { isGuardConfigurationPath, isPathOutsideWorkspace } from "./boundary-policy.js";

function interpreterPayloads(segment: string): string[] {
  const payloads: string[] = [];
  const inline = segment.match(/\b(?:python3?|node|perl|ruby|osascript|bash|sh|zsh|dash|ksh)\s+(?:(?:(?:-W|--input-type)\s+[^\s"']+|-[^\s"']+)\s+)*(?:-[a-zA-Z]*[ce]|--eval)\s*(?:"([^"]*)"|'([^']*)')/i);
  if (inline?.[1] || inline?.[2]) payloads.push(inline[1] ?? inline[2] ?? "");
  const heredoc = segment.match(/\b(?:python3?|node|perl|ruby|osascript|bash|sh|zsh|dash|ksh)\b[^\n]*<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s'";|&()<>\n]+))[^\n]*\n/i);
  if (heredoc) {
    const delimiter = heredoc[2] ?? heredoc[3] ?? heredoc[4];
    const lines = segment.slice((heredoc.index ?? 0) + heredoc[0].length).split("\n");
    const end = lines.findIndex((line) => (heredoc[1] ? line.replace(/^\t+/, "") : line) === delimiter);
    if (end >= 0) payloads.push(lines.slice(0, end).join("\n"));
  }
  const encodedPayloads = [
    segment.match(/\b(?:powershell|pwsh)\s+(?:-[a-zA-Z]*enc[a-zA-Z]*\s+)([A-Za-z0-9+/=]+)/i)?.[1],
    segment.match(/echo\s+["']?([A-Za-z0-9+/=]{4,})["']?\s*\|\s*base64\s+(?:-[a-zA-Z]*d[a-zA-Z]*|--decode)\s*\|\s*(?:bash|sh|zsh)/i)?.[1],
  ];
  for (const encoded of encodedPayloads) {
    if (!encoded) continue;
    const buf = Buffer.from(encoded, "base64");
    payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
  }
  return payloads;
}

const fileVerb = /\b(?:open|cat|read|readFile|readFileSync|read_text|readTextFile|write|writeFile|writeFileSync|write_text|writeTextFile|source|slurp|appendFile|appendFileSync|createReadStream|createWriteStream|load|loads|exec|execSync|spawn|spawnSync)\b/i;
// W214 (residual #27, issue #541): the write-target vocabulary completes the
// upstream policies/interpreter.ts set — Ruby File/IO writes and opens, the
// two-argument rename/copy forms, and pathlib write/replace forms join the
// previously ported node-fs / os-shutil / open() / redirect patterns.
const writeTargetPatterns = [
  /\b(?:File|IO)\.(?:write|binwrite|delete|unlink|rename)\s*\(\s*["']([^"']+)["']/g,
  /\bFile\.open\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wa+][^"']*["']/g,
  /\b(?:writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|cpSync|truncateSync)\s*\(\s*["']([^"']+)["']/g,
  /\b(?:renameSync|copyFileSync|cpSync)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g,
  /\b(?:os\.remove|os\.unlink|os\.rmdir|os\.mkdir|os\.makedirs|os\.rename|shutil\.rmtree|shutil\.copy|shutil\.copy2|shutil\.move)\s*\(\s*["']([^"']+)["']/g,
  /\b(?:os\.rename|shutil\.copy|shutil\.copy2|shutil\.move)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g,
  /\bopen\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wax+][^"']*["']/g,
  /\bPath\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|mkdir|touch|rename|replace)\s*\(/g,
  /\bPath\s*\(\s*["'][^"']+["']\s*\)\s*\.\s*(?:rename|replace)\s*\(\s*["']([^"']+)["']/g,
  /[>]{1,2}\s*["']?([^\s;&"'|)]+)/g,
];

/**
 * W214: upstream policies/interpreter.ts outsideWritePathInPayload — detects
 * workspace boundary escapes (writes/redirects to paths outside the workspace
 * root) initiated from inline interpreter payloads. The boundary classifier
 * fails closed on unresolvable/variable targets (treated as outside), the
 * same posture the shell-mutation boundary uses.
 */
export function outsideWritePathInPayload(payload: string, root: string): string | undefined {
  const candidates = new Set<string>();
  for (const pattern of writeTargetPatterns) {
    for (const match of payload.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  for (const candidate of candidates) {
    if (/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(candidate)) continue;
    if (isPathOutsideWorkspace(candidate, root)) return candidate;
  }
  return undefined;
}

/**
 * W214: upstream policies/interpreter.ts secretPathInPayload — a file-access
 * verb plus a secret credential path inside an inline interpreter payload.
 * Name and realpath matching ride the port's checkSecretPath (the upstream
 * isSecretPath equivalent); the root parameter replaces upstream's ambient
 * workspace state.
 */
export function secretPathInPayload(payload: string, workspaceRoot?: string): string | undefined {
  if (!fileVerb.test(payload)) return undefined;
  const tokens = payload.match(/["'][^"']*["']|[^\s(){}[\];,|&<>]+/g) ?? [];
  for (const token of tokens) {
    const cleaned = token.replace(/^["']|["']$/g, "");
    if (cleaned && checkSecretPath(cleaned, workspaceRoot)) return cleaned;
  }
  return undefined;
}

export function checkInterpreterPolicy(command: string, workspaceRoot?: string, liveConfigPaths?: readonly string[]): { policy: string; decision: "deny"; reason: string; matched?: string } | undefined {
  for (const payload of interpreterPayloads(command)) {
    // W214 (residual #27, issue #541): the upstream per-payload order —
    // workspace escape first, then the secret-path lane, then the wider
    // protected-token scan and the write-target loops (all fail-closed on
    // unresolvable destinations via the boundary classifier).
    if (workspaceRoot !== undefined) {
      const escape = outsideWritePathInPayload(payload, workspaceRoot);
      if (escape) return { decision: "deny", policy: "interpreter-workspace-escape", reason: `Interpreter payload writes path '${escape}' outside workspace '${workspaceRoot}'. All changes must stay within the workspace.`, matched: escape };
    }
    const secretPath = secretPathInPayload(payload, workspaceRoot);
    if (secretPath !== undefined) {
      return { decision: "deny", policy: "interpreter-secret-path", reason: `Interpreter payload references protected path '${secretPath}'.`, matched: secretPath };
    }
    if (fileVerb.test(payload)) {
      for (const token of payload.match(/["'][^"']*["']|[^\s(){}[\];,|&<>]+/g) ?? []) {
        const path = token.replace(/^["']|["']$/g, "");
        const match = checkProtectedPath(path, workspaceRoot);
        if (match) return { decision: "deny", policy: "interpreter-secret-path", reason: `Interpreter payload references protected path '${path}'.`, matched: path };
      }
    }
    for (const pattern of writeTargetPatterns) {
      for (const match of payload.matchAll(pattern)) {
        if (!match[1] || /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(match[1])) continue;
        // Upstream precedence: the tamper classification runs before the
        // system/secret check, so a config-shaped destination keeps its own
        // policy name even where a realpath would also match a system rule.
        if (isGuardConfigurationPath(match[1], workspaceRoot, liveConfigPaths)) return { decision: "deny", policy: "interpreter-guard-tamper", reason: `Interpreter payload writes guarded control-plane path '${match[1]}'.`, matched: match[1] };
        const protectedPath = checkProtectedPath(match[1], workspaceRoot);
        if (protectedPath) return { decision: "deny", policy: "interpreter-protected-write", reason: `Interpreter payload writes protected path '${match[1]}'.`, matched: match[1] };
      }
    }
  }
  return undefined;
}
