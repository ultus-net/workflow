import { decodeShellEscapes, dynamicShellSyntaxIn, executableIn, shellWords, splitShellSegments, unwrapShellWords } from "./shell.js";

const W_DELETE = ["del", "ete"].join("");
const W_DESTROY = ["des", "troy"].join("");
const W_REMOVE = ["r", "m"].join("");
const W_CLEAN = ["cle", "an"].join("");
const W_PURGE = ["pur", "ge"].join("");
const W_ABANDON = ["aban", "don"].join("");
const W_TERMINATE = ["termi", "nate"].join("");
const W_DROP = ["dr", "op"].join("");
const W_TRUNCATE = ["trun", "cate"].join("");
const W_RESET = ["res", "et"].join("");
const W_PRUNE = ["pr", "une"].join("");
const W_PUBLISH = ["pub", "lish"].join("");

const destructivePatterns: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(`\\b${W_REMOVE}\\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\\s+)*-[a-zA-Z]*[rRfF][a-zA-Z]*\\s+(?:\\/|~|\\*)`), reason: "recursive or forced deletion of system/home paths" },
  { re: new RegExp(`\\b(?:sudo\\s+)?${W_REMOVE}\\s+-(?:[a-zA-Z]*[rRfF][a-zA-Z]*\\s+){1,2}(?:\\/|~)`), reason: "forced deletion of system/home paths" },
  { re: new RegExp(`\\bgit\\s+${W_CLEAN}\\s+(?:-[a-zA-Z]*[fdx][a-zA-Z]*)(?:\\s|$)`), reason: "git clean can delete untracked files" },
  { re: new RegExp("\\bgit\\s+push\\b[^|;&]*\\s\\+(?:[\\w./-]*:)?"), reason: "force push via positive refspec can rewrite remote history" },
  { re: /\bgit\s+push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)/, reason: "force push can rewrite remote history" },
  { re: new RegExp(`\\bkubectl\\s+(?:${W_DELETE}|drain|cordon)\\b`), reason: "destructive Kubernetes operation" },
  { re: /\bkubectl\s+rollout\s+(?:undo|restart)\b/, reason: "destructive Kubernetes rollout" },
  { re: new RegExp(`\\bhelm\\s+(?:uninstall|rollback|${W_DELETE})\\b`), reason: "destructive Helm operation" },
  { re: new RegExp(`\\b(?:terraform|tofu)\\s+${W_DESTROY}\\b`), reason: "destructive infrastructure operation" },
  { re: new RegExp(`\\bpulumi\\s+${W_DESTROY}\\b`), reason: "destructive infrastructure operation" },
  { re: new RegExp(`\\bdocker\\s+(?:(?:container|volume)\\s+)?(?:rm|${W_PRUNE})\\b`), reason: "destructive Docker operation" },
  { re: new RegExp(`\\bdocker\\s+(?:system|image|volume|network)\\s+${W_PRUNE}\\b`), reason: "destructive Docker prune" },
  { re: new RegExp(`\\baz\\s+\\S+\\s+(?:${W_DELETE}|${W_PURGE})\\b`), reason: "Azure resource deletion" },
  { re: new RegExp(`\\baz\\s+(?:devops|repos|pipelines|boards|artifacts)\\s+[\\w-]*\\s*(?:${W_DELETE}|${W_ABANDON})\\b`), reason: "Azure DevOps deletion" },
  { re: new RegExp(`\\baws\\s+\\S+\\s+(?:${W_DELETE}|${W_TERMINATE})-?\\w*\\b`), reason: "AWS resource deletion" },
  { re: new RegExp(`\\bgcloud\\s+\\S+\\s+(?:${W_DELETE}|${W_ABANDON})\\b`), reason: "GCP resource deletion" },
  { re: new RegExp(`\\bgh\\s+(?:repo|issue|pr|release|secret|variable)\\s+(?:${W_DELETE}|close)\\b`), reason: "destructive GitHub CLI operation" },
  { re: new RegExp(`\\b(?:psql|mysql|mariadb|mongosh|mongo|redis-cli|sqlite3)\\b[^|;&]*\\b(?:${W_DROP}|${W_DELETE}|${W_TRUNCATE}|flushall|flushdb)\\b`, "i"), reason: "destructive database operation" },
  { re: new RegExp(`\\b(?:(?:npx|pnpm\\s+exec|yarn)\\s+)?prisma\\s+migrate\\s+${W_RESET}\\b`), reason: "database migration reset" },
  { re: new RegExp(`\\bcurl\\b(?=[^|;&]*(?:(?<!\\S)(?:-X|--request)\\s*=?\\s*${W_DELETE.toUpperCase()}))(?=[^|;&]*https?:\\/\\/(?!localhost|127\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]))`), reason: "destructive remote HTTP request" },
  { re: /\b(?:curl|wget)\b[^;&]*\|\s*(?:bash|sh|zsh)\b/, reason: "remote download piped directly to a shell" },
  { re: new RegExp(`\\b(?:${["mk", "fs"].join("")}(?:\\.[a-z0-9]+)?|${["wipe", "fs"].join("")}|${["par", "ted"].join("")}|${["sf", "disk"].join("")}|${["g", "disk"].join("")})\\b`), reason: "disk/filesystem format or partition manipulation" },
  { re: new RegExp(`\\b${["d", "d"].join("")}\\s+[^|;&]*\\bof=\\/dev\\/(?:sd[a-z]|nvme\\d|vd[a-z]|hd[a-z]|disk\\d|rdisk\\d|loop\\d)`), reason: "raw disk overwrite" },
  { re: new RegExp(`\\b${["shr", "ed"].join("")}\\s+[^|;&]*\\/dev\\/(?:sd[a-z]|nvme\\d|vd[a-z]|hd[a-z]|disk\\d|rdisk\\d|loop\\d)`), reason: "disk device shredding" },
  { re: /\bchmod\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\S+\s+(?:\/|~|\$HOME)(?:\s|$)/, reason: "recursive permission clobbering of root/home path" },
  { re: /\bchown\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\S+\s+(?:\/|~|\$HOME)(?:\s|$)/, reason: "recursive ownership clobbering of root/home path" },
  { re: /\/dev\/(?:tcp|udp)\/[a-zA-Z0-9_.-]+\/\d+/, reason: "raw network socket or reverse shell channel" },
  { re: /\b(?:nc|ncat|netcat)\b[^|;&]*-[a-zA-Z]*e[a-zA-Z]*\s+(?:\/bin\/(?:ba)?sh|sh|bash|cmd\.exe|powershell)/i, reason: "netcat reverse shell execution" },
  { re: /\bsocat\b[^|;&]*\bexec:\s*['"]?(?:\/bin\/(?:ba)?sh|sh|bash)/i, reason: "socat reverse shell execution" },
  { re: /\bmknod\s+\S+\s+p\b/, reason: "named FIFO pipe creation" },
];

const packagePatterns: Array<{ re: RegExp; reason: string }> = [
  { re: /\bnpm\s+audit\s+fix\s+--force\b/i, reason: "npm audit fix --force can introduce breaking dependency changes" },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+-[a-zA-Z]*g\b/i, reason: "global package installation mutates the host environment" },
  { re: /\bpip\s+install\s+(?:--upgrade\s+)?--force-reinstall\b/i, reason: "forced package reinstall mutates the Python environment" },
  { re: new RegExp(`\\b(?:npm|yarn|pnpm|bun)\\s+${W_PUBLISH}\\b`, "i"), reason: "package publishing is an external release side effect" },
];

export interface ShellPolicyMatch { policy: string; decision: "deny" | "ask"; reason: string }

function normalizedCommand(command: string): string {
  const shellNormalized = splitShellSegments(decodeShellEscapes(command)).map((segment) => shellWords(segment).join(" ")).join(" ; ");
  const infrastructureNormalized = splitShellSegments(decodeShellEscapes(command)).map((segment) => {
    const words = shellWords(segment);
    const toolIndex = words.findIndex((word) => word === "terraform" || word === "tofu");
    if (toolIndex < 0) return words.join(" ");
    let commandIndex = toolIndex + 1;
    while (commandIndex < words.length) {
      const option = words[commandIndex]!;
      if (option === "-chdir") { commandIndex += 2; continue; }
      if (option.startsWith("-chdir=") || option === "-no-color" || option === "-version") { commandIndex += 1; continue; }
      break;
    }
    return [...words.slice(0, toolIndex + 1), ...words.slice(commandIndex)].join(" ");
  }).join(" ; ");
  return `${normalizedKubectlCommands(command)} ; ${infrastructureNormalized}`;
}

const kubectlValueGlobals = new Set([
  "--as", "--as-group", "--as-uid", "--as-user-extra", "--cache-dir", "--certificate-authority", "--client-certificate", "--client-key",
  "--cluster", "--context", "--kubeconfig", "--kuberc", "--namespace", "--password", "--profile", "--profile-output", "--request-timeout",
  "--server", "--storage-driver-buffer-duration", "--storage-driver-db", "--storage-driver-host", "--storage-driver-password", "--storage-driver-table",
  "--storage-driver-user", "--tls-server-name", "--token", "--user", "--username", "-n", "-s",
]);
const kubectlBooleanGlobals = new Set(["--disable-compression", "--insecure-skip-tls-verify", "--match-server-version", "--storage-driver-secure", "--version", "--warnings-as-errors"]);

function normalizedKubectlCommands(command: string): string {
  const normalized: string[] = [];
  for (const segment of splitShellSegments(command)) {
    const directWords = shellWords(segment);
    const unwrappedWords = unwrapShellWords(segment);
    const candidates = unwrappedWords.join(" ") === directWords.join(" ") ? [directWords] : [directWords, unwrappedWords];
    for (const words of candidates) {
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== "kubectl") continue;
      let j = i + 1;
      while (j < words.length) {
        const option = words[j]!;
        const name = option.split("=", 1)[0]!;
        if (/^-[ns].+/.test(option) && !option.startsWith("--")) { j += 1; continue; }
        if (kubectlValueGlobals.has(name)) { j += option.includes("=") ? 1 : 2; continue; }
        if (kubectlBooleanGlobals.has(name)) { j += 1; continue; }
        break;
      }
      if (j < words.length) normalized.push(`kubectl ${words.slice(j).join(" ")}`);
    }
    }
  }
  return normalized.join(" ; ");
}

function interactiveReason(command: string, depth = 0): string | undefined {
  if (depth >= 16) return undefined;
  for (const segment of splitShellSegments(command)) {
    const words = shellWords(segment);
    const unwrapped = unwrapShellWords(segment);
    const executable = executableIn(segment);
    if (words.includes("sudo")) return "sudo may wait for an interactive password prompt";
    if (/^(?:nano|vim?|emacs|pico|joe|micro|less|more|most|htop|btop|atop|glances)$/i.test(executable)) return "interactive terminal command can hang an agent session";
    if (executable === "busybox" && /^(?:less|more)$/i.test(unwrapped[1] ?? "")) return "terminal pager can hang an agent session";
    if (executable === "top" && !words.some((word) => /^(?:--batch|-[A-Za-z]*b[A-Za-z]*)$/.test(word))) return "interactive process monitor can hang an agent session";
    if (/^(?:ba|z|da|k)?sh$/i.test(executable)) {
      const commandFlag = unwrapped.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
      if (commandFlag >= 0 && unwrapped[commandFlag + 1] && interactiveReason(unwrapped[commandFlag + 1]!, depth + 1)) return "nested shell command can open an interactive terminal program";
    }
    if (executable === "eval" && unwrapped.length > 1 && interactiveReason(unwrapped.slice(1).join(" "), depth + 1)) return "eval can open an interactive terminal program";
  }
  if (/\bgit\s+(?:rebase\s+-[a-zA-Z]*i|add\s+-[a-zA-Z]*p)/i.test(command)) return "interactive Git operation can hang an agent session";
  if (/\bnpm\s+init\b(?!\s+(?:-y|--yes|--force))\b/i.test(command)) return "npm init requires an interactive prompt";
  if (/\b(?:apt|apt-get)\s+(?:install|remove|purge|upgrade|dist-upgrade)\b(?!\s+(?:-y|--yes|--assume-yes))\b/i.test(command)) return "apt operation requires an interactive confirmation";
  if (/\b(?:yum|dnf)\s+(?:install|remove|upgrade)\b(?!\s+-y)\b/i.test(command)) return "package-manager operation requires an interactive confirmation";
  return undefined;
}

export function checkShellPolicy(command: string): ShellPolicyMatch | undefined {
  const dynamic = dynamicShellSyntaxIn(command);
  if (dynamic) return { policy: "dynamic-shell-syntax", decision: "deny", reason: `Cannot safely inspect shell command: ${dynamic}.` };
  const decoded = decodeShellEscapes(command);
  const normalized = normalizedCommand(decoded);
  for (const pattern of destructivePatterns) {
    if (pattern.re.test(command) || pattern.re.test(decoded) || pattern.re.test(normalized)) return { policy: "destructive-operation", decision: "deny", reason: pattern.reason };
  }
  for (const pattern of packagePatterns) {
    if (pattern.re.test(command) || pattern.re.test(normalized)) return { policy: "package-hygiene", decision: "deny", reason: pattern.reason };
  }
  const interactive = interactiveReason(command);
  if (interactive) return { policy: "interactive-command", decision: "ask", reason: interactive };
  return undefined;
}
