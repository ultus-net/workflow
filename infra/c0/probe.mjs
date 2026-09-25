#!/usr/bin/env node
// C0 live probe: prove SSE + basic auth survive Container Apps external ingress.
// Reads ./c0.env (written by deploy.sh). Gates:
//   1. health        — version-tolerant: v2 /api/info, fallback v1 /global/health
//   2. negative-auth — unauthenticated request is rejected (401/403)
//   3. sse roundtrip — open /api/event, create a session over the same ingress,
//                      expect stream bytes within the window; delete the session.
// Exit 0 only when all gates pass. Record the verdict in README.md afterward.
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('./c0.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
if (!env.C0_BASE_URL || !env.C0_SERVER_PASSWORD) {
  console.error('c0.env missing or incomplete — run deploy.sh first');
  process.exit(2);
}

const base = env.C0_BASE_URL.replace(/\/+$/, '');
const auth = 'Basic ' + Buffer.from('opencode:' + env.C0_SERVER_PASSWORD).toString('base64');

let failures = 0;
function verdict(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -- ' + detail : ''));
  if (!ok) failures += 1;
}

async function health() {
  try {
    let r = await fetch(base + '/api/info', { headers: { authorization: auth } });
    if (r.status === 200) {
      const body = await r.text();
      verdict('health /api/info', true, body.slice(0, 140));
      return;
    }
    r = await fetch(base + '/global/health', { headers: { authorization: auth } });
    const body = await r.text();
    verdict(
      'health /global/health',
      r.status === 200 && body.includes('true'),
      'status ' + r.status + ' ' + body.slice(0, 100),
    );
  } catch (e) {
    verdict('health', false, String(e));
  }
}

async function negative() {
  try {
    const r = await fetch(base + '/api/info');
    verdict('unauthenticated rejected', r.status === 401 || r.status === 403, 'status ' + r.status);
  } catch (e) {
    verdict('unauthenticated rejected', false, String(e));
  }
}

async function sseRoundTrip() {
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), 25000);
  try {
    const stream = await fetch(base + '/api/event', {
      headers: { authorization: auth, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const ct = stream.headers.get('content-type') || '';
    if (stream.status !== 200 || !ct.includes('text/event-stream')) {
      verdict('sse stream open', false, 'status ' + stream.status + ' content-type ' + ct);
      return;
    }
    verdict('sse stream open', true, 'content-type ' + ct.split(';')[0]);

    const reader = stream.body.getReader();
    const create = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'c0-probe' }),
    });
    const created = await create.json();
    const sessionId = created && created.data ? created.data.id : null;
    if (!sessionId) {
      verdict('session create', false, 'status ' + create.status + ' ' + JSON.stringify(created).slice(0, 140));
      return;
    }
    verdict('session create', true, 'id ' + sessionId);

    let bytes = 0;
    const drain = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.value) bytes += chunk.value.length;
        if (chunk.done) break;
      }
    })();
    await Promise.race([drain, new Promise((res) => setTimeout(res, 12000))]);
    verdict('sse activity round-trip', bytes > 0, bytes + ' bytes after session create');

    const del = await fetch(base + '/api/session/' + sessionId, {
      method: 'DELETE',
      headers: { authorization: auth },
    });
    verdict('session cleanup', del.status === 200 || del.status === 204, 'status ' + del.status);
    controller.abort();
  } catch (e) {
    verdict('sse roundtrip', false, String(e));
  } finally {
    clearTimeout(hardStop);
  }
}

await health();
await negative();
await sseRoundTrip();
console.log(failures === 0 ? 'C0 PROBE: PASS' : 'C0 PROBE: ' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
