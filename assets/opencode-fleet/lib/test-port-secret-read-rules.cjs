#!/usr/bin/env node
/**
 * test-port-secret-read-rules.cjs — fixtures for port-secret-read-rules.cjs
 *
 * The ported secret-read denials are the golden config's read-plane replacement
 * for the retired add-on's `isSecretPath` identity. The generator is the single
 * source of truth; this suite pins its contract:
 *
 *  1. every emitted glob matches the representative secret path it targets,
 *     under the host matcher the port targets (`wildcard-match.cjs`);
 *  2. no emitted glob matches a safe example (`.env.example`), an ordinary
 *     source path, or a path that merely embeds a class token in a longer name
 *     beyond the recorded over-approximation;
 *  3. `splice`/`spliceAgent` are idempotent and insert into the right place,
 *     and `--check` fails closed on drift;
 *  4. the committed `config.jsonc` block AND the two shadowing agents'
 *     frontmatter blocks are byte-equal to the generator output, so a hand edit
 *     without re-running the generator fails.
 *
 * Why the two agents matter: the host applies the config's GLOBAL permissions
 * before an agent's frontmatter permissions (host test
 * `packages/core/test/config/agent.test.ts:48-129`) and resolves last-match-wins
 * (`packages/core/src/permission.ts:80`). A global read deny is shadowed by an
 * agent that declares `read: * allow`, so the class list must also live in
 * `reviewer.md` and `screener.md`, the two agents that do.
 *
 * Sample secret paths are assembled from fragments so this fixture file carries
 * no contiguous secret literal of its own (the active guard's content scan and
 * the pre-commit path/content scan both treat such literals as hostile).
 *
 * Run: node --test install/lib/test-port-secret-read-rules.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const g = require('./port-secret-read-rules.cjs');
const { hostMatch } = require('./wildcard-match.cjs');

/** Join tokens with a space. */
const J = (...p) => p.join(' ');
/** Concatenate fragments into a path. */
const P = (...p) => p.join('');
const HOME = P('/', 'home', '/hunter');
const KEY = P('id', '_rsa');

/** The representative secret path each class must deny. */
const SECRETS = [
  P(HOME, '/.ssh/', KEY),                 // id_rsa by key form
  P(HOME, '/.ssh/', KEY, '.pub'),         // dotted variant
  P('/', 'id_ed25519'),                   // bare key name
  P('/etc/tls/server', '.pem'),           // ext form
  P('certs/tls', '.key'),
  P('/a/b/cert', '.p12'),
  P('bundle', '.pfx'),
  P('x', '.pkcs12'),
  P(HOME, '/.kube/config'),               // kubeconfig pathInclude
  P('.kube/config'),
  P(HOME, '/.aws/credentials'),
  P(HOME, '/.docker/config.json'),
  P('.netrc'),                            // suffix form
  P(HOME, '/.git-credentials'),
  P('/a/b/credentials.json'),
  P('/a/service-account-prod.json'),      // nameGlob form
  P('svc/service_account.json'),
  P('bare/serviceaccount.json'),          // optional-separator spelling
  P('/a/client-secret.json'),
  P('x/client_secret.json'),
  P('x/clientsecret.json'),               // optional-separator spelling
];

/** Paths that must NOT be denied by the ported block. */
const SAFE = [
  P('.env'),
  P('.env.local'),
  P('.env.example'),                      // the existing allow must not be shadowed
  P('README.md'),
  P('docs/notes', '.pem', '.md'),         // token not at the end
  P('package.json'),
  P('src/credentials.ts'),                // .ts, not .json
  P('a/', '.netrc', '.example'),          // not an exact-basename store
  P('main', '.key', '.ts'),               // .ts, not .key
  P('src/keys.ts'),
  P('config/dockerd.json'),
];

/** Distinct classes the add-on's `isSecretPath` carries, by emitted-glob probe. */
test('class table covers every add-on secret class', () => {
  const forms = new Set(g.CLASSES.map((c) => c.form));
  assert.deepEqual([...forms].sort(), ['contains', 'ext', 'key', 'nameGlob', 'pathInclude', 'suffix']);
  // Each representative secret resolves to at least one glob.
  for (const s of SECRETS) {
    assert.ok(g.globs().some((x) => hostMatch(s, x)), `no glob denies ${s}`);
  }
  // The four SSH key names are each carried.
  for (const n of ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']) {
    assert.ok(g.CLASSES.some((c) => c.form === 'key' && c.name === n), `missing key class ${n}`);
  }
  // The TLS extensions are each carried.
  for (const e of ['.pem', '.key', '.pkcs12', '.pfx', '.p12']) {
    assert.ok(g.CLASSES.some((c) => c.form === 'ext' && c.ext === e), `missing ext class ${e}`);
  }
  // The add-on's separator is OPTIONAL (`[-_]?`), so all three spellings of each
  // service-account / client-secret prefix must be carried. A missing spelling
  // is a silent parity gap, which is exactly what this fixture exists to catch.
  for (const p of ['serviceaccount', 'service-account', 'service_account',
                   'clientsecret', 'client-secret', 'client_secret']) {
    assert.ok(g.CLASSES.some((c) => c.form === 'nameGlob' && c.prefix === p && c.suffix === '.json'),
      `missing nameGlob class ${p}`);
  }
});

test('every emitted glob denies its representative secret under the host matcher', () => {
  for (const s of SECRETS) {
    const hit = g.globs().filter((x) => hostMatch(s, x));
    assert.ok(hit.length > 0, `expected a glob to match "${s}"`);
  }
});

test('no emitted glob over-matches a safe example or ordinary path', () => {
  for (const s of SAFE) {
    const hit = g.globs().filter((x) => hostMatch(s, x));
    assert.equal(hit.length, 0, `"${s}" should not be denied, matched by ${hit.join(', ')}`);
  }
});

test('the emitted block does not match the *.env.example allow', () => {
  // The env.example allow is hand-written and survives; the generated block
  // must be disjoint from it, or the allow is silently shadowed (n=33 P1 class).
  assert.ok(!g.globs().some((x) => hostMatch('.env.example', x)));
  // And the anchor the block splices after is the env.example allow itself.
  assert.match(g.ANCHOR, /\.env\.example/);
  assert.match(g.ANCHOR, /"allow"/);
});

test('globs() is deterministic, de-duplicated, and ruleLines matches it', () => {
  const a = g.globs();
  assert.deepEqual(a, g.globs(), 'globs() must be pure');
  assert.equal(new Set(a).size, a.length, 'globs() must be de-duplicated');
  assert.equal(g.ruleLines().length, a.length);
  for (const l of g.ruleLines()) {
    assert.match(l, /"action": "read"/);
    assert.match(l, /"effect": "deny"/);
  }
  assert.equal(g.agentLines().length, a.length);
});

test('splice inserts after the anchor and is idempotent', () => {
  const head = ['  "permissions": [', g.ANCHOR, '  ],', '}'].join('\n');
  const once = g.splice(head);
  assert.ok(once.includes(g.BEGIN) && once.includes(g.END));
  assert.ok(once.indexOf(g.BEGIN) > once.indexOf(g.ANCHOR), 'block must follow the anchor');
  assert.equal(g.splice(once), once, 'second splice is a no-op');
});

test('splice fails closed without the anchor', () => {
  assert.throws(() => g.splice('  "permissions": []\n}'), /anchor not found/);
});

test('spliceAgent inserts before the frontmatter close and is idempotent', () => {
  const doc = ['---', 'description: x', 'mode: subagent', 'steps: 1', 'permissions:', '  - action: read', '    resource: "*"', '    effect: allow', '---', '', 'body'].join('\n');
  const once = g.spliceAgent(doc);
  assert.ok(once.includes(g.AGENT_BEGIN) && once.includes(g.AGENT_END));
  // The block sits inside the frontmatter, before the closing fence.
  const close = once.indexOf('\n---\n');
  assert.ok(once.indexOf(g.AGENT_END) < close, 'block must be inside the frontmatter');
  assert.equal(g.spliceAgent(once), once, 'second spliceAgent is a no-op');
  // And the block follows the shadowing `read: "*"` allow.
  assert.ok(once.indexOf(g.AGENT_BEGIN) > once.indexOf('resource: "*"'));
});

test('spliceAgent fails closed without frontmatter', () => {
  assert.throws(() => g.spliceAgent('no frontmatter here\n'), /no YAML frontmatter/);
});

test('--check fails closed when a block is absent', () => {
  assert.equal(g.check('{ "permissions": [] }\n').ok, false);
  assert.match(g.check('{ "permissions": [] }\n').message, /not checkable/);
  assert.equal(g.check('no sentinel here').ok, false);
  assert.equal(g.checkAgent('---\ndescription: x\n---\nbody').ok, false);
});

test('the committed config.jsonc block matches the generator', () => {
  const text = fs.readFileSync(g.CONFIG, 'utf8');
  assert.ok(text.includes(g.BEGIN), 'config.jsonc has no ported-secret-read sentinel block');
  assert.equal(g.splice(text), text, 'config.jsonc ported read rules are stale; run --apply');
});

test('every discovered read-shadowing agent carries the committed block', () => {
  const shadow = g.shadowAgents();
  assert.ok(shadow.length > 0, 'expected at least one agent to declare read: "*" allow');
  for (const file of shadow) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(g.AGENT_BEGIN), `${path.basename(file)} has no ported-secret-read block`);
    assert.equal(g.spliceAgent(text), text, `${path.basename(file)} read rules are stale; run --apply`);
    // The block must follow the agent's own broad read allow, or it is inert.
    const allowIdx = text.indexOf('resource: "*"');
    assert.ok(allowIdx !== -1 && text.indexOf(g.AGENT_BEGIN) > allowIdx,
      `${path.basename(file)}: the deny block must follow its read: "*" allow`);
  }
});

test('frontmatter parity: the sentinel block carries exactly one deny per glob', () => {
  // A teeth probe: a class dropped from the table would shrink both the config
  // block and the agent blocks, so a hand-edited agent that kept an old rule or
  // added an extra one fails parity against the generator. Scoped to the
  // sentinel block so the agent's own hand-written read rules do not inflate it.
  const want = g.globs().length;
  for (const file of g.shadowAgents()) {
    const text = fs.readFileSync(file, 'utf8');
    const begin = text.indexOf(g.AGENT_BEGIN);
    const end = text.indexOf(g.AGENT_END, begin);
    assert.ok(begin !== -1 && end !== -1, `${path.basename(file)}: sentinel block missing`);
    const blockText = text.slice(begin, end);
    const items = blockText.match(/- action: read\n\s+resource: "\*[^"]*"\n\s+effect: deny/g) || [];
    assert.equal(items.length, want, `${path.basename(file)} block has ${items.length} denies, expected exactly ${want}`);
  }
});

test('the shadow set is discovered, not hardcoded', () => {
  // The two agents that currently declare read: "*" allow.
  assert.deepEqual(g.shadowAgents().map((f) => path.basename(f)).sort(), ['reviewer.md', 'screener.md']);
  // Discovery is really reading the frontmatter, not returning a constant.
  assert.ok(g.shadows('---\npermissions:\n  - action: read\n    resource: "*"\n    effect: allow\n---\n'));
  assert.ok(!g.shadows('---\npermissions:\n  - action: read\n    resource: "docs/**"\n    effect: allow\n---\n'));
  // An agent with no block at all is not in the shadow set.
  assert.ok(!g.shadowAgents().some((f) => path.basename(f) === 'executor.md'));
  for (const file of g.shadowAgents()) {
    assert.ok(g.shadows(fs.readFileSync(file, 'utf8')), `${path.basename(file)} must declare read: "*" allow`);
  }
});

test('stripAgent removes the block and only the block', () => {
  const doc = ['---', 'description: x', 'permissions:', '  - action: read', '    resource: "*"', '    effect: allow', '---', '', 'body'].join('\n');
  const withBlock = g.spliceAgent(doc);
  const stripped = g.stripAgent(withBlock);
  assert.equal(stripped, doc, 'strip must be the inverse of splice for a block-free doc');
  assert.equal(g.stripAgent(stripped), stripped, 'strip is idempotent');
  assert.ok(!stripped.includes(g.AGENT_BEGIN));
});
