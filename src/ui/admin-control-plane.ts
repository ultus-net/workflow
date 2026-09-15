import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { CredentialControlPlane, CredentialDefinition } from "../integrations/credentials.js";

export type CredentialAuditEvent = {
  actor: "admin";
  action: "set" | "revoke";
  credentialId: string;
  consumers: readonly string[];
};

export function createAdminControlPlaneServer(options: {
  credentials: CredentialControlPlane;
  adminToken: string;
  audit?: (event: CredentialAuditEvent) => void;
}) {
  if (options.adminToken.length < 16) throw new TypeError("admin capability must be at least 16 characters");
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") return html(response, ADMIN_PAGE);
    if (url.pathname === "/admin.js") return asset(response, "text/javascript; charset=utf-8", ADMIN_SCRIPT);
    if (url.pathname === "/admin.css") return asset(response, "text/css; charset=utf-8", ADMIN_STYLE);
    if (!url.pathname.startsWith("/api/admin/")) return json(response, 404, { error: "not found" });
    if (!hasAdminCapability(request, options.adminToken)) return json(response, 401, { error: "admin capability required" });

    if (url.pathname === "/api/admin/credentials" && request.method === "GET") {
      return json(response, 200, await options.credentials.list());
    }
    if (url.pathname === "/api/admin/credentials" && request.method === "PUT") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        return json(response, 415, { error: "application/json required" });
      }
      try {
        const input = await readJson(request);
        if (!isCredentialInput(input)) return json(response, 400, { error: "invalid credential" });
        const { value, ...definition } = input;
        await options.credentials.set(definition, value);
        options.audit?.({ actor: "admin", action: "set", credentialId: definition.id, consumers: definition.allowedConsumers });
        response.writeHead(204).end();
        return;
      } catch {
        return json(response, 400, { error: "invalid credential" });
      }
    }
    if (url.pathname.startsWith("/api/admin/credentials/") && request.method === "DELETE") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      const id = decodeURIComponent(url.pathname.slice("/api/admin/credentials/".length));
      try {
        const metadata = (await options.credentials.list()).find((credential) => credential.id === id);
        await options.credentials.revoke(id);
        options.audit?.({ actor: "admin", action: "revoke", credentialId: id, consumers: metadata?.allowedConsumers ?? [] });
        response.writeHead(204).end();
      } catch {
        json(response, 404, { error: "credential unavailable" });
      }
      return;
    }
    return json(response, 404, { error: "not found" });
  });
}

function hasAdminCapability(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isTrustedMutation(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return request.headers["sec-fetch-site"] !== "cross-site";
  const host = request.headers.host;
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

type CredentialInput = CredentialDefinition & { value: string };
function isCredentialInput(input: unknown): input is CredentialInput {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  return typeof value.id === "string" && typeof value.label === "string" &&
    (value.kind === "api-key" || value.kind === "token") && typeof value.value === "string" &&
    Array.isArray(value.allowedConsumers) && value.allowedConsumers.every((item) => typeof item === "string") &&
    Array.isArray(value.allowedPurposes) && value.allowedPurposes.every((item) => typeof item === "string") &&
    (value.workspace === undefined || typeof value.workspace === "string");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new TypeError("request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function asset(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}
function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflow Admin</title><link rel="stylesheet" href="/admin.css"></head><body><main><header><p class="eyebrow">WORKFLOW / CONTROL PLANE</p><h1>Credential custody</h1><p>Broker access without exposing stored values.</p></header><section class="auth"><label>Admin capability <input id="token" type="password" autocomplete="off"></label><button id="connect">Connect</button></section><section><div class="section-head"><h2>Credentials</h2><button id="add">Add credential</button></div><div id="credentials" class="grid"><p>Authenticate to inspect credential metadata.</p></div></section></main><dialog id="editor"><form id="form"><h2>Add or replace</h2><label>ID <input name="id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label><label>Label <input name="label" required></label><label>Secret value <input name="value" type="password" required autocomplete="new-password"></label><label>Consumer <input name="consumer" placeholder="mcp:github" required></label><label>Environment variable <input name="variable" placeholder="GITHUB_TOKEN" required></label><label>Workspace <input name="workspace"></label><div class="actions"><button type="button" id="cancel">Cancel</button><button>Store securely</button></div></form></dialog><script src="/admin.js"></script></body></html>`;
const ADMIN_SCRIPT = `let token='';const q=s=>document.querySelector(s);async function load(){const r=await fetch('/api/admin/credentials',{headers:{Authorization:'Bearer '+token}});if(!r.ok){q('#credentials').textContent='Authentication failed.';return}const rows=await r.json();q('#credentials').replaceChildren(...rows.map(c=>{const el=document.createElement('article');const h=document.createElement('h3');h.textContent=c.label;const p=document.createElement('p');p.textContent=c.id+' · '+c.kind+' · '+(c.configured?'configured':'missing');const scope=document.createElement('small');scope.textContent=c.allowedConsumers.join(', ')+(c.workspace?' · '+c.workspace:'');const b=document.createElement('button');b.textContent='Revoke';b.onclick=async()=>{await fetch('/api/admin/credentials/'+encodeURIComponent(c.id),{method:'DELETE',headers:{Authorization:'Bearer '+token}});await load()};el.append(h,p,scope,b);return el}))}q('#connect').onclick=()=>{token=q('#token').value;q('#token').value='';load()};q('#add').onclick=()=>q('#editor').showModal();q('#cancel').onclick=()=>q('#editor').close();q('#form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body={id:f.get('id'),label:f.get('label'),kind:'api-key',value:f.get('value'),allowedConsumers:[f.get('consumer')],allowedPurposes:['stdio-env:'+f.get('variable')],...(f.get('workspace')?{workspace:f.get('workspace')}:{})};const r=await fetch('/api/admin/credentials',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});if(r.ok){e.currentTarget.reset();q('#editor').close();await load()}}`;
const ADMIN_STYLE = `:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#0c1110;color:#e8eee9}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#19352b 0,transparent 35rem)}main{width:min(1080px,calc(100% - 2rem));margin:4rem auto}header{max-width:42rem;margin-bottom:3rem}.eyebrow{font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.16em;color:#72d9a7}h1{font:500 clamp(2.5rem,7vw,5.5rem)/.95 Georgia,serif;margin:.3rem 0 1rem}.auth,.section-head,.actions{display:flex;gap:.75rem;align-items:end;justify-content:space-between}.auth{padding:1rem;border:1px solid #2b3a34;background:#111816;margin-bottom:3rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1px;background:#2b3a34;border:1px solid #2b3a34}article{background:#101614;padding:1.25rem}article button{margin-top:1.25rem}small{display:block;color:#9bad9f}button,input{font:inherit}button{border:1px solid #456055;background:#1c2924;color:#e8eee9;padding:.55rem .9rem;cursor:pointer}button:hover{border-color:#72d9a7}input{display:block;width:100%;margin-top:.3rem;background:#090d0c;color:#fff;border:1px solid #35463f;padding:.6rem}.auth label{flex:1}dialog{color:#e8eee9;background:#101614;border:1px solid #456055;width:min(480px,calc(100% - 2rem))}dialog::backdrop{background:#000b}form{display:grid;gap:1rem}@media(max-width:600px){main{margin:2rem auto}.auth{align-items:stretch;flex-direction:column}.section-head{align-items:center}}`;
