import { checkProtectedPath } from "./path-policy.js";

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
const writeTargetPatterns = [
  /\b(?:writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|cpSync|truncateSync)\s*\(\s*["']([^"']+)["']/g,
  /\b(?:os\.remove|os\.unlink|os\.rmdir|os\.mkdir|os\.makedirs|os\.rename|shutil\.rmtree|shutil\.copy|shutil\.copy2|shutil\.move)\s*\(\s*["']([^"']+)["']/g,
  /\bopen\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wax+][^"']*["']/g,
  /[>]{1,2}\s*["']?([^\s;&"'|)]+)/g,
];

export function checkInterpreterPolicy(command: string, workspaceRoot?: string): { policy: string; decision: "deny"; reason: string } | undefined {
  for (const payload of interpreterPayloads(command)) {
    if (fileVerb.test(payload)) {
      for (const token of payload.match(/["'][^"']*["']|[^\s(){}[\];,|&<>]+/g) ?? []) {
        const path = token.replace(/^["']|["']$/g, "");
        const match = checkProtectedPath(path, workspaceRoot);
        if (match) return { decision: "deny", policy: "interpreter-secret-path", reason: `Interpreter payload references protected path '${path}'.` };
      }
    }
    for (const pattern of writeTargetPatterns) {
      for (const match of payload.matchAll(pattern)) {
        if (!match[1] || /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(match[1])) continue;
        const protectedPath = checkProtectedPath(match[1], workspaceRoot);
        if (protectedPath) return { decision: "deny", policy: "interpreter-protected-write", reason: `Interpreter payload writes protected path '${match[1]}'.` };
      }
    }
  }
  return undefined;
}
