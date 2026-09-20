import assert from "node:assert/strict";
import test from "node:test";

import { MutationBudget } from "../src/application/mutation-budget.js";

test("parent-owned mutation budget is inherited by descendants", () => {
  const budget = new MutationBudget(2);
  budget.register("parent");
  budget.register("child", "parent");
  assert.equal(budget.consume("child"), true);
  assert.equal(budget.consume("parent"), true);
  assert.equal(budget.consume("child"), false);
  assert.equal(budget.count("child"), 2);
});

test("mutation budget rejects parent cycles and validates the bound", () => {
  assert.throws(() => new MutationBudget(0), /positive/);
  const budget = new MutationBudget();
  budget.register("a", "b");
  budget.register("b", "a");
  assert.throws(() => budget.count("a"), /cycle/);
});