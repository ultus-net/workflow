import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import { taskId, type TaskState } from "../kernel/contracts.js";

const STATES: readonly TaskState[] = ["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"];

export function createWorkflowWebServer(application: WorkflowApplication) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") return html(response, PAGE);
    if (request.method === "GET" && request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return response.end(APP_JS);
    }
    if (request.method === "GET" && request.url === "/api/snapshot") return json(response, 200, application.snapshot());
    if (request.method === "POST" && request.url === "/api/transition") {
      try {
        const body = await readJson(request);
        if (!isTransitionRequest(body)) return json(response, 400, { error: "invalid transition request" });
        const result = application.transition(taskId(body.taskId), body.requested);
        return json(response, result.kind === "accepted" ? 200 : 409, result);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    return json(response, 404, { error: "not found" });
  });
}

function isTransitionRequest(value: unknown): value is { taskId: string; requested: TaskState } {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return typeof input.taskId === "string" && STATES.includes(input.requested as TaskState);
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
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  response.end(body);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflow Control</title><style>
body{font:15px ui-monospace,SFMono-Regular,Consolas,monospace;max-width:72rem;margin:0 auto;padding:2rem;background:#f5f3ee;color:#20201d}header{display:flex;justify-content:space-between;border-bottom:2px solid;padding-bottom:1rem}main{display:grid;grid-template-columns:2fr 1fr;gap:2rem}section{margin-top:1.5rem}button{font:inherit;padding:.35rem .6rem;background:transparent;border:1px solid;cursor:pointer}.task{display:grid;grid-template-columns:7rem 9rem 1fr auto;gap:1rem;padding:.6rem 0;border-bottom:1px solid #bbb}.muted{opacity:.6}@media(max-width:700px){body{padding:1rem}main{display:block}.task{grid-template-columns:5rem 7rem 1fr}.task button{grid-column:3}}
</style></head><body><header><strong>Workflow Control</strong><span id="host">connecting</span></header><main><section><h2>Tasks</h2><div id="tasks"></div></section><aside><section><h2>Evidence</h2><div id="evidence"></div></section><section><h2>History</h2><div id="history"></div></section></aside></main><script src="/app.js"></script></body></html>`;

const APP_JS = `
const next={READY:'IN_PROGRESS',IN_PROGRESS:'VERIFYING',VERIFYING:'VERIFIED'};
const esc=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
async function refresh(){const s=await fetch('/api/snapshot').then(r=>r.json());document.querySelector('#host').textContent=s.enforcementLevel.toUpperCase()+' / '+s.transport;document.querySelector('#tasks').innerHTML=s.tasks.map(t=>'<div class="task '+(t.state==='BLOCKED'?'muted':'')+'"><strong>'+esc(t.id)+'</strong><span>'+esc(t.state)+'</span><span>'+esc(t.title)+(t.blockers.length?' [blocked by '+esc(t.blockers.join(', '))+']':'')+'</span>'+(next[t.state]?'<button data-task="'+esc(t.id)+'" data-next="'+next[t.state]+'">Advance</button>':'')+'</div>').join('');document.querySelector('#evidence').innerHTML=s.evidence.length?s.evidence.map(e=>'<p class="'+(e.freshness==='stale'?'muted':'')+'">'+esc(e.subject)+': '+esc(e.result)+' / '+esc(e.freshness)+'</p>').join(''):'<p class="muted">none observed</p>';document.querySelector('#history').innerHTML=s.history.length?s.history.slice(-8).map(h=>'<p>'+esc(h.taskId)+': '+esc(h.from)+' -> '+esc(h.to)+'</p>').join(''):'<p class="muted">no transitions</p>';}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-task]');if(!b)return;await fetch('/api/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:b.dataset.task,requested:b.dataset.next})});await refresh()});refresh();`;
