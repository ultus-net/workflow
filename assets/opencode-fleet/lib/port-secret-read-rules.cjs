#!/usr/bin/env node
/**
 * port-secret-read-rules.cjs
 *
 * The READ plane of the golden config. n=33 ported the add-on's
 * destructive-command (shell) classes into `install/opencode/config.jsonc`;
 * the read plane was left at three env rules. The retired enforcement add-on
 * (opencode-workflow-guard) also held a secret-FILE identity: SSH/TLS key
 * material, cloud/cluster/service-account credentials, `.netrc`,
 * `.git-credentials` (`src/policies/secrets.ts` `isSecretPath`). A read deny is
 * the only boundary for an INTERNAL path, where `external_directory` never
 * fires, so a clean install without the add-on has no read boundary for an
 * in-project or home-rooted secret file.
 *
 * The classes are a data table, not prose: this module is the single source of
 * truth, and `--apply` splices them into BOTH places the host resolves.
 *
 * Why BOTH places. The host resolves a permission request last-match-wins
 * (`packages/core/src/permission.ts:80`, `findLast`) and applies the config's
 * GLOBAL `permissions` BEFORE an agent's own frontmatter permissions (host test
 * `packages/core/test/config/agent.test.ts:48-129`). A global read deny is
 * therefore SHADOWED by any agent that declares `read: * allow` in its
 * frontmatter — which is why `reviewer.md` and `screener.md` already duplicate
 * the env read rules. So this generator writes the class list into the global
 * config block AND into those two agents' frontmatter, or the boundary is
 * absent for the two most-used subagents. This is the n=33 P1 shadow class
 * (spliced-after-deny downgrade), one plane over.
 *
 * Coverage and residuals are documented in
 * `docs/agents/proposals/secret-read-port.md`. The host matches a rule
 * `resource` as an anchored glob (`*` -> `.*`, case-sensitive) per
 * `packages/core/src/util/wildcard.ts`; this module emits only forms that glob
 * can express, and names the over-approximation the glob cannot avoid.
 *
 * Modes:
 *   (default)  print the config block that would be emitted
 *   --apply    splice the class list into config.jsonc and the two agents
 *   --check    exit 1 if any target's sentinel block is not byte-equal to the
 *              generator output (used by the fixture suite / pre-commit)
 *
 * Exit codes: 0 clean, 1 drift/unwritable, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OPENCODE = path.resolve(__dirname, '..', 'opencode');
const CONFIG = path.join(OPENCODE, 'config.jsonc');
const AGENT_DIR = path.join(OPENCODE, 'agents');
const ALL_AGENTS = fs
  .readdirSync(AGENT_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => path.join(AGENT_DIR, f));

// A frontmatter `- action: read / resource: "*" / effect: allow` item. Any agent
// carrying it shadows a GLOBAL read deny under last-match-wins, so it must carry
// its own copy of the class list. This set is DISCOVERED, not listed: a new agent
// that declares the broad allow is picked up automatically, and an agent that
// drops it is stripped automatically, so the set cannot silently rot.
const SHADOW_ALLOW = /^\s*- action: read\n\s+resource: "\*"\n\s+effect: allow\s*$/m;

/** True when the agent file declares a frontmatter `read: * allow`. Pure on `text`. */
function shadows(text) {
  return SHADOW_ALLOW.test(text);
}

/** The agents that currently shadow a global read deny. Reads the agent dir. */
function shadowAgents() {
  return ALL_AGENTS.filter((f) => {
    try { return shadows(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
}

const BEGIN = '    // >>> ported-secret-read-rules (generated — run install/lib/port-secret-read-rules.cjs --apply) <<<';
const END = '    // <<< ported-secret-read-rules <<<';
const AGENT_BEGIN = '  # >>> ported-secret-read-rules (generated — run install/lib/port-secret-read-rules.cjs --apply) <<<';
const AGENT_END = '  # <<< ported-secret-read-rules <<<';

// The config anchor is the last hand-written read rule, the `*.env.example`
// allow. The generated block is spliced AFTER it, so the block's denies take
// precedence over anything above under last-match-wins (none of them match
// `.env.example`, but the ordering is stated so a later edit cannot invert it).
const ANCHOR = '    { "action": "read", "resource": "*.env.example", "effect": "allow" },';

// Each class mirrors one operator in the add-on's `isSecretPath` basename test
// (`src/policies/secrets.ts:44-83`). The form name names the operator, so a
// reader can diff this table against that function by eye.
//
//   key        -> basename matches /^NAME(\.|$)/      (`*NAME`, `*NAME.*`)
//   ext        -> basename ends with `.ext`           (`*.ext`)
//   contains   -> basename CONTAINS token             (`*TOKEN*`)
//   pathInclude-> full path CONTAINS `TAIL`           (`*TAIL*`)
//   suffix     -> basename ends with `TAIL`           (`*TAIL`)
//   nameGlob   -> basename matches /^PREFIX.*SUFFIX$/ (`*PREFIX*SUFFIX`)
//
// Over-approximation (residual, named in the proposal): a full-path anchored
// glob cannot express "basename STARTS WITH X" or "basename CONTAINS X" as
// cheaply as the add-on's basename regex. The `key`, `nameGlob`, `contains` and
// `pathInclude` forms therefore also deny a path that merely EMBEDS the token
// (e.g. `xid_rsa`, `x-service-account-prod.json`, `docs/kubeconfig/README.md`).
// Over-denying a credential-shaped name is the safe direction for a read
// boundary and is recorded, not hidden.
const CLASSES = [
  // SSH key material: basename /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.
  { form: 'key', name: 'id_rsa' },
  { form: 'key', name: 'id_dsa' },
  { form: 'key', name: 'id_ecdsa' },
  { form: 'key', name: 'id_ed25519' },
  // TLS / PKCS key material: basename /\.(pem|key|pkcs12|pfx|p12)$/.
  { form: 'ext', ext: '.pem' },
  { form: 'ext', ext: '.key' },
  { form: 'ext', ext: '.pkcs12' },
  { form: 'ext', ext: '.pfx' },
  { form: 'ext', ext: '.p12' },
  // kubeconfig: basename /kubeconfig/i (CONTAINS).
  { form: 'contains', token: 'kubeconfig' },
  // Whole-file credential stores by EXACT basename.
  { form: 'suffix', tail: '.netrc' },
  { form: 'suffix', tail: '.git-credentials' },
  // Fixed dot-dirs: full path CONTAINS.
  { form: 'pathInclude', tail: '.kube/config' },
  { form: 'pathInclude', tail: '.aws/credentials' },
  { form: 'pathInclude', tail: '.docker/config.json' },
  // Generic credential store: basename ends with `credentials.json`.
  { form: 'suffix', tail: 'credentials.json' },
  // Service-account / client-secret JSON. The add-on's operator is
  // /^(service[-_]?account|client[-_]?secret).*\.json$/i, where `[-_]?` makes
  // the separator OPTIONAL: three spellings each (none, hyphen, underscore).
  { form: 'nameGlob', prefix: 'serviceaccount', suffix: '.json' },
  { form: 'nameGlob', prefix: 'service-account', suffix: '.json' },
  { form: 'nameGlob', prefix: 'service_account', suffix: '.json' },
  { form: 'nameGlob', prefix: 'clientsecret', suffix: '.json' },
  { form: 'nameGlob', prefix: 'client-secret', suffix: '.json' },
  { form: 'nameGlob', prefix: 'client_secret', suffix: '.json' },
];

/** Build the resource globs for one class. Pure. */
function resources(c) {
  switch (c.form) {
    case 'key':         return [`*${c.name}`, `*${c.name}.*`];
    case 'ext':         return [`*${c.ext}`];
    case 'contains':    return [`*${c.token}*`];
    case 'pathInclude': return [`*${c.tail}*`];
    case 'suffix':      return [`*${c.tail}`];
    case 'nameGlob':    return [`*${c.prefix}*${c.suffix}`];
    default: throw new Error(`unknown form: ${c.form}`);
  }
}

/** Every emitted resource glob, de-duplicated, in class order. Pure. */
function globs() {
  const seen = new Set();
  const out = [];
  for (const c of CLASSES) {
    for (const g of resources(c)) {
      if (!seen.has(g)) { seen.add(g); out.push(g); }
    }
  }
  return out;
}

/** The generated JSONC rule lines, sentinel-exclusive. Pure. */
function ruleLines() {
  return globs().map((g) => `    { "action": "read", "resource": "${g}", "effect": "deny" },`);
}

/** The generated YAML frontmatter item lines, sentinel-exclusive. Pure. */
function agentLines() {
  return globs().map((g) => `  - action: read\n    resource: "${g}"\n    effect: deny`);
}

/** The sentinel-fenced JSONC block. Pure. */
function block() {
  return [BEGIN, ...ruleLines(), END].join('\n');
}

/** The sentinel-fenced YAML frontmatter block. Pure. */
function agentBlock() {
  return [AGENT_BEGIN, ...agentLines(), AGENT_END].join('\n');
}

/** Replace or insert a sentinel block in `text` given begin/end markers. Pure. */
function spliceWith(text, begin, end, anchor, blockText, insertAfterAnchor) {
  const beginIdx = text.indexOf(begin);
  if (beginIdx !== -1) {
    const endIdx = text.indexOf(end, beginIdx);
    if (endIdx === -1) throw new Error('sentinel BEGIN present but END missing');
    const endLine = text.indexOf('\n', endIdx);
    if (endLine === -1) throw new Error('sentinel END is the last line');
    return text.slice(0, beginIdx) + blockText + text.slice(endLine);
  }
  const i = anchor == null ? -1 : text.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found');
  const at = insertAfterAnchor ? i + anchor.length : text.lastIndexOf('\n', i) + 1;
  return text.slice(0, at) + '\n' + blockText + text.slice(at);
}

/** Replace the config sentinel block, or insert after the env.example allow. Pure. */
function splice(text) {
  return spliceWith(text, BEGIN, END, ANCHOR, block(), true);
}

/**
 * Splice the agent frontmatter block immediately before the closing `---` of
 * the leading frontmatter. Pure. Throws when there is no frontmatter or no
 * closing fence, so a malformed agent fails closed rather than silently skipping.
 */
function spliceAgent(text) {
  const fm = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!fm) throw new Error('agent has no YAML frontmatter');
  const closeIdx = fm[0].length - (fm[0].endsWith('\r\n---\r\n') ? 5 : 4);
  const body = text.slice(0, closeIdx);
  const rest = text.slice(closeIdx);
  const beginIdx = body.indexOf(AGENT_BEGIN);
  const replaced = beginIdx === -1
    ? `${body}${agentBlock()}\n`
    : (() => {
        const endIdx = body.indexOf(AGENT_END, beginIdx);
        if (endIdx === -1) throw new Error('agent sentinel BEGIN present but END missing');
        const endLine = body.indexOf('\n', endIdx);
        if (endLine === -1) throw new Error('agent sentinel END is the last line');
        return body.slice(0, beginIdx) + agentBlock() + body.slice(endLine);
      })();
  return replaced + rest;
}

/**
 * Remove the agent sentinel block (sentinel lines and the rules between them).
 * Pure. Used when an agent stops declaring `read: "*" allow` and must shed the
 * deny set, so no stale block outlives the reason it was written.
 */
function stripAgent(text) {
  const beginIdx = text.indexOf(AGENT_BEGIN);
  if (beginIdx === -1) return text;
  const endIdx = text.indexOf(AGENT_END, beginIdx);
  if (endIdx === -1) throw new Error('agent sentinel BEGIN present but END missing');
  let endLine = text.indexOf('\n', endIdx);
  if (endLine === -1) endLine = text.length;
  else endLine += 1;
  return text.slice(0, beginIdx) + text.slice(endLine);
}

/** Check config text against the generator output. Pure. Returns {ok, message}. */function check(text) {
  let want;
  try { want = splice(text); }
  catch (e) { return { ok: false, message: `block is not checkable: ${e.message}` }; }
  if (!text.includes(BEGIN)) return { ok: false, message: 'sentinel block is absent' };
  if (want !== text) return { ok: false, message: 'sentinel block is stale' };
  return { ok: true, message: `sentinel block is current (${globs().length} rules)` };
}

/** Check one agent file against the generator output. Pure. Returns {ok, message}. */
function checkAgent(text) {
  let want;
  try { want = spliceAgent(text); }
  catch (e) { return { ok: false, message: `block is not checkable: ${e.message}` }; }
  if (!text.includes(AGENT_BEGIN)) return { ok: false, message: 'sentinel block is absent' };
  if (want !== text) return { ok: false, message: 'sentinel block is stale' };
  return { ok: true, message: `sentinel block is current (${globs().length} rules)` };
}

module.exports = {
  CONFIG, ALL_AGENTS, BEGIN, END, AGENT_BEGIN, AGENT_END, ANCHOR, CLASSES,
  resources, globs, ruleLines, agentLines, block, agentBlock,
  splice, spliceAgent, stripAgent, check, checkAgent, shadows, shadowAgents,
};

if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== undefined && !['--apply', '--check'].includes(mode)) {
    console.error(`unknown argument: ${mode}`);
    process.exit(2);
  }

  const rel = (f) => path.relative(process.cwd(), f);

  if (mode === '--check') {
    let bad = 0;
    let text;
    try { text = fs.readFileSync(CONFIG, 'utf8'); }
    catch { console.error(`  \u2717  config not readable: ${CONFIG}`); process.exit(1); }
    const rc = check(text);
    if (!rc.ok) { console.error(`  \u2717  ported-secret-read-rules (config) ${rc.message}; run --apply`); bad = 1; }
    else console.log(`  \u2713  ported-secret-read-rules (config) ${rc.message}`);
    const shadow = new Set(shadowAgents().map(rel));
    for (const file of ALL_AGENTS) {
      let at;
      try { at = fs.readFileSync(file, 'utf8'); }
      catch { console.error(`  \u2717  agent not readable: ${rel(file)}`); bad = 1; continue; }
      if (shadow.has(rel(file))) {
        const ra = checkAgent(at);
        if (!ra.ok) { console.error(`  \u2717  ported-secret-read-rules (${rel(file)}) ${ra.message}; run --apply`); bad = 1; }
        else console.log(`  \u2713  ported-secret-read-rules (${rel(file)}) ${ra.message}`);
      } else if (at.includes(AGENT_BEGIN)) {
        console.error(`  \u2717  ported-secret-read-rules (${rel(file)}) carries a block but no longer declares read: "*" allow; run --apply`);
        bad = 1;
      }
    }
    if (!bad) console.log(`  \u2713  ported-secret-read-rules (agents) ${shadow.size} shadowing agent(s)`);
    process.exit(bad ? 1 : 0);
  }

  if (mode === '--apply') {
    const shadow = shadowAgents();
    const shadowSet = new Set(shadow);
    const targets = [
      { file: CONFIG, fn: splice },
      ...shadow.map((file) => ({ file, fn: spliceAgent })),
      // Agents that stopped declaring the broad read allow must shed the block,
      // or a stale deny set lingers with no generator behind it.
      ...ALL_AGENTS.filter((f) => !shadowSet.has(f) && fs.readFileSync(f, 'utf8').includes(AGENT_BEGIN))
        .map((file) => ({ file, fn: stripAgent })),
    ];
    for (const { file, fn } of targets) {
      let next;
      try { next = fn(fs.readFileSync(file, 'utf8')); }
      catch (e) { console.error(`cannot apply to ${rel(file)}: ${e.message}`); process.exit(1); }
      if (next === fs.readFileSync(file, 'utf8')) { console.log(`already current (no change): ${rel(file)}`); continue; }
      fs.writeFileSync(file, next);
      console.log(`applied ${globs().length} read denies to ${rel(file)}`);
    }
    process.exit(0);
  }

  console.log(block());
}
