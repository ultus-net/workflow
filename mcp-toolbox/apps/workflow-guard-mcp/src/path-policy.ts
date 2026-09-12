import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const SAFE_ENV_FIXTURE_RE = /\.env\.(example|sample|template|dist|schema)(\.[\w-]+)*$/i;

function isSecretName(path: string): boolean {
  const base = basename(path).toLowerCase();
  const full = path.toLowerCase().replaceAll("\\", "/");
  if (SAFE_ENV_FIXTURE_RE.test(base)) return false;
  return /^\.env(?:\.|$)/i.test(base)
    || /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base)
    || /\.(pem|key|pkcs12|pfx|p12)$/i.test(base)
    || /kubeconfig/i.test(base)
    || full.includes("/.kube/config")
    || /^(service[-_]?account|client[-_]?secret).*\.json$/i.test(base)
    || /credentials\.json$/i.test(base)
    || full.includes("/.aws/credentials")
    || full.includes("/.docker/config.json")
    || base === ".netrc"
    || base === ".git-credentials";
}

function realPathWithMissingTail(path: string): string | undefined {
  let ancestor = path;
  while (true) {
    try {
      return resolve(realpathSync(ancestor), relative(ancestor, path));
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
  }
}

export function checkProtectedPath(path: string, workspaceRoot?: string): string | undefined {
  const lexical = workspaceRoot && !isAbsolute(path) ? resolve(workspaceRoot, path) : path;
  const candidates = [lexical];
  const real = workspaceRoot || isAbsolute(path) ? realPathWithMissingTail(lexical) : undefined;
  if (real && real !== lexical) candidates.push(real);
  for (const candidate of candidates) {
    const normalized = candidate.replaceAll("\\", "/");
    if (/^\/etc(?:\/|$)/.test(normalized) || /^\/usr(?:\/|$)/.test(normalized) || /^\/var(?:\/|$)/.test(normalized) || /(?:^|\/)\.ssh(?:\/|$)/.test(normalized)) return "protected system or credential path";
    if (isSecretName(candidate)) return "secret credential path";
  }
  return undefined;
}

export function checkSecretPath(path: string, workspaceRoot?: string): boolean {
  const lexical = workspaceRoot && !isAbsolute(path) ? resolve(workspaceRoot, path) : path;
  if (isSecretName(lexical)) return true;
  const real = workspaceRoot || isAbsolute(path) ? realPathWithMissingTail(lexical) : undefined;
  return real ? isSecretName(real) : false;
}

const secretPatterns: Array<{ re: RegExp; reason: string }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, reason: "private key material" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key ID" },
  { re: /\bASIA[0-9A-Z]{16}\b/, reason: "AWS temporary session credential" },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, reason: "GitHub personal access token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/, reason: "GitHub fine-grained PAT" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, reason: "OpenAI-style API key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: "Google API key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, reason: "Slack token" },
  { re: /(?:^|\s)(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENAI_KEY)\s*=\s*\S+/, reason: "credential assignment" },
];

export function secretIn(content: string): string | undefined {
  return secretPatterns.find(({ re }) => re.test(content))?.reason;
}
