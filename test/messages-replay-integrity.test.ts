import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectMessagesSchemaReplayViolations,
  enforceMessagesReplayIntegrity,
  MESSAGES_REPLAY_POLICY,
  unparseableMessagesBodyRejection,
} from "../src/integrations/messages-replay-integrity.js";

// P9 option D (issue #288, 2026-09-30): the anthropic Messages-schema replay
// integrity check. The pure detector is the messages-lane sibling of
// `detectSyntheticToolCallTurns` (src/integrations/model-replay-policy.ts): it
// flags the unpaired halves of a tool_use/tool_result turn (a tool_use never
// answered by a result; a result never attributable to a preceding tool_use)
// and a thinking block whose preserved signature was stripped. It is a pure
// function — no IO, no family classification, no model contract.
//
// THE W070b CAUTION (pinned below): the anthropic-messages transport is
// W070b's SANCTIONED synthetic-tool-call path (deepseek's `route-anthropic`
// decision). The reject tier must not false-reject the insertion patterns the
// replay policy itself routes to this lane, so the detector permits a MATCHED
// synthetic tool_use/tool_result pair — only the unpaired halves are refused.

const SANCTIONED_SYNTHETIC_INSERTION = [
  { role: "user", content: "run the tool" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should call the tool.", signature: "sig-abc" },
      { type: "tool_use", id: "call_seed", name: "read", input: {} },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call_seed", content: "seeded result" }],
  },
];

test("P9 D: the W070b sanctioned synthetic-tool-call insertion is allowed (never false-rejected)", () => {
  assert.deepEqual(detectMessagesSchemaReplayViolations(SANCTIONED_SYNTHETIC_INSERTION), []);
  const decision = enforceMessagesReplayIntegrity({ model: "deepseek-flash", messages: SANCTIONED_SYNTHETIC_INSERTION });
  assert.equal(decision.action, "allow");
  assert.equal(decision.policy, MESSAGES_REPLAY_POLICY);
});

test("P9 D: a matched tool_use/tool_result pair with parallel results is attributed and allowed", () => {
  const parallel = [
    { role: "user", content: "inspect both files" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "read_a", input: {} },
        { type: "tool_use", id: "call_b", name: "read_b", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_b", content: "file B" },
        { type: "tool_result", tool_use_id: "call_a", content: "file A" },
      ],
    },
  ];
  assert.deepEqual(detectMessagesSchemaReplayViolations(parallel), []);
});

test("P9 D: a dangling tool_use with no answering tool_result is refused (unanswered-tool-use)", () => {
  const dangling = [
    { role: "user", content: "run the tool" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_x", name: "read", input: {} }] },
  ];
  const violations = detectMessagesSchemaReplayViolations(dangling);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["unanswered-tool-use"],
  );
  assert.equal(violations[0]?.index, 1, "the violation points at the assistant turn that owns the dangling tool_use");

  const decision = enforceMessagesReplayIntegrity({ model: "deepseek-flash", messages: dangling });
  assert.equal(decision.action, "reject");
  if (decision.action === "reject") {
    assert.match(decision.reason, /messages-schema replay integrity/);
    assert.equal(decision.policy, MESSAGES_REPLAY_POLICY);
    assert.deepEqual(
      decision.violations.map((violation) => violation.code),
      ["unanswered-tool-use"],
    );
  }
});

test("P9 D: a tool_result with no preceding tool_use is refused (unattributed-tool-result)", () => {
  const stripped = [
    { role: "user", content: "run the tool" },
    { role: "assistant", content: [{ type: "text", text: "I ran it." }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_missing", content: "x" }] },
  ];
  const violations = detectMessagesSchemaReplayViolations(stripped);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["unattributed-tool-result"],
  );
  assert.equal(violations[0]?.index, 2, "the violation points at the user turn that carries the orphaned result");
});

test("P9 D: a bare tool_result with no tool_use anywhere is refused — the call is the discriminator (safe by construction)", () => {
  // Safe-by-construction assessment (2026-09-30, harvest-4): a real host's
  // Messages body cannot carry a tool_result without its tool_use — the schema
  // pairs a user tool_result with the assistant turn's tool_use, and W070b's
  // sanctioned synthetic insertion (the traffic this lane exists to carry,
  // src/integrations/model-replay-policy.ts:70-75) is a MATCHED pair, pinned
  // above. The unattributed-tool-result refusal therefore fires only on a body
  // the vendor's own schema would reject; no valid host body is false-rejected.
  // This pin fixes the boundary: dropping the call from the sanctioned shape
  // turns it into exactly one unattributed-tool-result, never an allow.
  const droppedCall = [SANCTIONED_SYNTHETIC_INSERTION[0], SANCTIONED_SYNTHETIC_INSERTION[2]];
  const violations = detectMessagesSchemaReplayViolations(droppedCall);
  assert.deepEqual(violations.map((violation) => violation.code), ["unattributed-tool-result"]);
  assert.equal(violations[0]?.index, 1, "the violation points at the user turn that carries the orphaned result");
  assert.equal(enforceMessagesReplayIntegrity({ model: "deepseek-flash", messages: droppedCall }).action, "reject");
  // The call is the discriminator: restoring it allows the exact same body.
  assert.deepEqual(detectMessagesSchemaReplayViolations(SANCTIONED_SYNTHETIC_INSERTION), []);
});

test("P9 D: a thinking block with a stripped signature is refused (missing-thinking-signature)", () => {
  const unsigned = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hi" }] },
  ];
  const violations = detectMessagesSchemaReplayViolations(unsigned);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["missing-thinking-signature"],
  );

  const signed = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig-1" }, { type: "text", text: "hi" }] },
  ];
  assert.deepEqual(detectMessagesSchemaReplayViolations(signed), [], "a preserved signature is replayed cleanly");
});

test("P9 D: a plain conversation with no tool or thinking blocks is allowed", () => {
  const plain = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  assert.deepEqual(detectMessagesSchemaReplayViolations(plain), []);
  assert.equal(enforceMessagesReplayIntegrity({ model: "glm-5.3", messages: plain }).action, "allow");
});

test("P9 D: a body with no messages array fails closed (missing-messages)", () => {
  const decision = enforceMessagesReplayIntegrity({ model: "deepseek-flash" });
  assert.equal(decision.action, "reject");
  if (decision.action === "reject") {
    assert.match(decision.reason, /messages-schema replay integrity/);
    assert.deepEqual(
      decision.violations.map((violation) => violation.code),
      ["missing-messages"],
    );
  }
});

test("P9 D: the unparseable-body refusal is structured and named", () => {
  const rejection = unparseableMessagesBodyRejection();
  assert.equal(rejection.action, "reject");
  assert.equal(rejection.policy, MESSAGES_REPLAY_POLICY);
  assert.match(rejection.reason, /messages-schema replay integrity/);
  assert.deepEqual(
    rejection.violations.map((violation) => violation.code),
    ["unparseable-body"],
  );
});
