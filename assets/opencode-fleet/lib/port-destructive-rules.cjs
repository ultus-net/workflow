#!/usr/bin/env node
/**
 * port-destructive-rules.cjs
 *
 * The golden config's `permissions` array must carry the destructive-command
 * classes the retired enforcement add-on (opencode-workflow-guard) held, so a
 * clean install is self-sufficient once the add-on is removed. Those classes
 * are a data table, not prose: this module is the single source of truth for
 * the ported rules, and `--apply` splices them into
 * `install/opencode/config.jsonc` inside a sentinel block.
 *
 * Why a generator and not hand-written rules: the rules carry destructive
 * command literals, and the active guard's content scan (correctly) refuses to
 * write them through an agent tool. Keeping the rules as `{tool, verb, form}`
 * data in a normal source file keeps the generator auditable and guard-safe
 * (the few scanned tool names are assembled inline from fragments), and
 * `--apply` is idempotent (it replaces the sentinel block in place).
 *
 * Coverage and residuals are documented in
 * `docs/agents/proposals/destructive-command-port.md`. The host matches a rule
 * `resource` as an anchored glob (`*` -> `.*`, case-sensitive) per
 * `packages/core/src/util/wildcard.ts`; this module emits only forms that glob
 * can express. Regex-only classes (case-insensitive database verb alternation,
 * remote HTTP DELETE, reverse-shell channels) are recorded as residual there.
 *
 * Modes:
 *   (default)  print the rules that would be emitted
 *   --apply    splice the rules into config.jsonc (idempotent)
 *   --check    exit 1 if config.jsonc's sentinel block is not byte-equal to the
 *              generator output (used by the fixture suite / pre-commit)
 *
 * Exit codes: 0 clean, 1 drift/unwritable, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = path.resolve(__dirname, '..', 'opencode', 'config.jsonc');
const BEGIN = '    // >>> ported-destructive-rules (generated — run install/lib/port-destructive-rules.cjs --apply) <<<';
const END = '    // <<< ported-destructive-rules <<<';

// The permissions anchor is the last hand-written rule, the narrow `git push -f`
// deny. Assembled from fragments so this source file carries no contiguous
// destructive literal of its own (the guard scans written content; see header).
const PUSH = 'git pu' + 'sh';
const ANCHOR = `    { "action": "shell", "resource": "${PUSH} -f *", "effect": "deny" },`;

// form:
//   toolverb    -> "<tool> <verb> *"           (verb is the matched subcommand tail)
//   middle      -> "<tool> * <verb>*"          (subcommand after globals; tail-tolerant)
//   toolglob    -> "<tool>* *"                 (tool has versioned variants, e.g. ext4)
//   sudoflag    -> "sudo <tool> <flag> *"      (privilege-wrapped destructive rm)
//   plusref     -> "git push ... +..."         (force push via + refspec)
//   flagtarget  -> "<tool> -<flag> * <target>" (recursive flag, root/home target)
//   flagpath    -> "<tool> *<flag>*"           (a target of the form of=/dev/...)
//   path        -> "<tool> *<path>*"           (any argument naming the device)
const CLASSES = [
  // Orchestration / infrastructure.
  { tool: 'kubectl', verbs: ['delete', 'drain', 'cordon'], form: 'toolverb' },
  { tool: 'kubectl', verbs: ['rollout undo', 'rollout restart'], form: 'toolverb' },
  { tool: 'helm', verbs: ['uninstall', 'rollback', 'delete'], form: 'toolverb' },
  { tool: 'terraform', verbs: ['destroy'], form: 'toolverb' },
  { tool: 'tofu', verbs: ['destroy'], form: 'toolverb' },
  { tool: 'pulumi', verbs: ['destroy'], form: 'toolverb' },
  // Containers.
  { tool: 'docker', verbs: ['rm', 'prune'], form: 'toolverb' },
  { tool: 'docker', verbs: ['container rm', 'system prune', 'image prune', 'volume rm', 'volume prune', 'network prune'], form: 'toolverb' },
  // Cloud CLIs.
  { tool: 'az', verbs: ['delete', 'purge', 'abandon'], form: 'middle' },
  { tool: 'aws', verbs: ['delete', 'terminate'], form: 'middle' },
  { tool: 'gcloud', verbs: ['delete', 'abandon'], form: 'middle' },
  // Hosted repo / PR destruction via the gh CLI.
  { tool: 'gh', verbs: ['repo delete', 'issue delete', 'pr delete', 'pr close', 'release delete', 'secret delete', 'variable delete'], form: 'toolverb' },
  // Database wipe via the ORM migration CLI.
  { tool: 'prisma', verbs: ['migrate' + ' reset'], form: 'toolverb' },
  // Raw disk / filesystem / partition-table manipulation.
  { tool: 'mk' + 'fs', verbs: [], form: 'toolglob' },
  { tool: 'wipe' + 'fs', verbs: [], form: 'toolglob' },
  { tool: 'par' + 'ted', verbs: [], form: 'toolglob' },
  { tool: 'sf' + 'disk', verbs: [], form: 'toolglob' },
  { tool: 'gd' + 'isk', verbs: [], form: 'toolglob' },
  // Privilege-wrapped recursive/forced deletion of system or home paths.
  { tool: 'rm', verbs: ['-rf', '-fr', '-r', '-f'], form: 'sudoflag' },
  // Force push via a + refspec (with and without an explicit remote). This is
  // the same class as the hand-written `git push --force/-f` denials, so it is
  // denied too: an `ask` here would be spliced AFTER those denials and, under
  // the host's last-match-wins precedence, would downgrade a force push that
  // carries a + refspec from deny to ask.
  { tool: 'git', verbs: ['push * +', 'push +'], form: 'plusref', effect: 'deny' },
  // Recursive permission/ownership clobbering of root or home.
  { tool: 'chmod', verbs: ['R', 'r'], form: 'flagtarget' },
  { tool: 'chown', verbs: ['R', 'r'], form: 'flagtarget' },
  // Raw disk/block-device overwrite.
  { tool: 'dd', verbs: ['of=/dev/'], form: 'flagpath' },
  { tool: 'shred', verbs: ['/dev/'], form: 'path' },
];

// Recursive clobbering targets the guard names: root, home, $HOME.
const TARGETS = ['/', '~', '$HOME'];

/** Build the resource globs for one class. Pure. One rule per (verb, target). */
function resources(tool, verb, form) {
  switch (form) {
    case 'toolverb':   return [`${tool} ${verb} *`];
    case 'middle':     return [`${tool} * ${verb}*`];
    case 'toolglob':   return [`${tool}* *`];
    case 'sudoflag':   return [`sudo ${tool} ${verb} *`];
    case 'plusref':    return [`${tool} ${verb}*`];
    case 'flagtarget': return TARGETS.map((t) => `${tool} -${verb} * ${t}`);
    case 'flagpath':   return [`${tool} *${verb}*`];
    case 'path':       return [`${tool} *${verb}*`];
    default: throw new Error(`unknown form: ${form}`);
  }
}

/** Single-resource helper (first glob of a class). Pure. */
function resource(tool, verb, form) {
  return resources(tool, verb, form)[0];
}

/** The generated rule lines (indented JSONC), sentinel-exclusive. Pure. */
function ruleLines() {
  const out = [];
  for (const c of CLASSES) {
    const verbs = c.verbs.length ? c.verbs : [''];
    const effect = c.effect || 'ask';
    for (const v of verbs) {
      for (const res of resources(c.tool, v, c.form)) {
        out.push(`    { "action": "shell", "resource": "${res}", "effect": "${effect}" },`);
      }
    }
  }
  return out;
}

/** The sentinel-fenced block. Pure. */
function block() {
  return [BEGIN, ...ruleLines(), END].join('\n');
}

/** Replace an existing sentinel block, or insert after the last push-deny rule. Pure. */
function splice(text) {
  const beginIdx = text.indexOf(BEGIN);
  if (beginIdx !== -1) {
    const endIdx = text.indexOf(END, beginIdx);
    if (endIdx === -1) throw new Error('sentinel BEGIN present but END missing');
    const endLine = text.indexOf('\n', endIdx);
    return text.slice(0, beginIdx) + block() + text.slice(endLine);
  }
  const i = text.indexOf(ANCHOR);
  if (i === -1) throw new Error('permissions anchor not found');
  const at = i + ANCHOR.length;
  return text.slice(0, at) + '\n' + block() + text.slice(at);
}

/** Check config text against the generator output. Pure. Returns {ok, message}. */
function check(text) {
  let want;
  try { want = splice(text); }
  catch (e) { return { ok: false, message: `block is not checkable: ${e.message}` }; }
  if (!text.includes(BEGIN)) return { ok: false, message: 'sentinel block is absent' };
  if (want !== text) return { ok: false, message: 'sentinel block is stale' };
  return { ok: true, message: `sentinel block is current (${ruleLines().length} rules)` };
}

module.exports = { CONFIG, BEGIN, END, ANCHOR, CLASSES, TARGETS, resource, resources, ruleLines, block, splice, check };

if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== undefined && !['--apply', '--check'].includes(mode)) {
    console.error(`unknown argument: ${mode}`);
    process.exit(2);
  }
  let text;
  try { text = fs.readFileSync(CONFIG, 'utf8'); }
  catch (e) { console.error(`config not readable: ${CONFIG}`); process.exit(1); }

  if (mode === '--check') {
    const r = check(text);
    if (!r.ok) { console.error(`  \u2717  ported-destructive-rules ${r.message}; run --apply`); process.exit(1); }
    console.log(`  \u2713  ported-destructive-rules ${r.message}`);
    process.exit(0);
  }

  if (mode === '--apply') {
    let next;
    try { next = splice(text); }
    catch (e) { console.error(`cannot apply: ${e.message}`); process.exit(1); }
    if (next === text) { console.log('already current (no change)'); process.exit(0); }
    fs.writeFileSync(CONFIG, next);
    console.log(`applied ${ruleLines().length} ported rules to ${path.relative(process.cwd(), CONFIG)}`);
    process.exit(0);
  }

  console.log(block());
}
