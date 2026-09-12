import assert from "node:assert/strict";
import test from "node:test";

test("fails", () => assert.equal(1, 2, "fixture failure"));
