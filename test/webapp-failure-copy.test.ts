import assert from "node:assert/strict";
import test from "node:test";

import { describeFailure } from "../src/ui/webapp/failure-copy.js";

test("describeFailure maps connection failures to a plain cause and next step", () => {
  const raw = 'ACP request failed: {"code":-32603,"message":"Internal error: Cannot connect to API: Unable to connect. (ConnectionRefused)","data":{"message":"Cannot connect to API"}}';
  const failure = describeFailure(raw);
  assert.match(failure.summary, /couldn't reach the model API/);
  assert.match(failure.summary, /retry/i);
  assert.equal(failure.detail, raw);
});

test("describeFailure maps cancellations, denials, and timeouts", () => {
  assert.equal(describeFailure("ACP turn cancelled by the agent").summary, "The turn was cancelled.");
  assert.match(describeFailure("mutation denied: task is BLOCKED").summary, /Workflow denied this action/);
  assert.match(describeFailure("request timed out after 30s").summary, /timed out/);
});

test("describeFailure degrades unknown shapes to their first line without detail", () => {
  const failure = describeFailure("something unexpected happened\nwith a second line");
  assert.equal(failure.summary, "something unexpected happened");
  assert.equal(failure.detail, undefined);
});
