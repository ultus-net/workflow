import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MUTATION_BUDGET, MutationBudget, mutationBudgetFromEnv } from "../src/application/mutation-budget.js";

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

test("WORKFLOW_MUTATION_BUDGET is configurable, defaults honestly, and fails closed", () => {
  // Unset (or blank) is the documented default, byte-identical to pre-config.
  assert.equal(mutationBudgetFromEnv({} as NodeJS.ProcessEnv), DEFAULT_MUTATION_BUDGET);
  assert.equal(mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "   " } as NodeJS.ProcessEnv), DEFAULT_MUTATION_BUDGET);
  // An operator-raised cap is honored.
  assert.equal(mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "5000" } as NodeJS.ProcessEnv), 5000);
  // A broken cap must never degrade to an arbitrary/unenforced budget.
  assert.throws(() => mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "0" } as NodeJS.ProcessEnv), /positive integer/);
  assert.throws(() => mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "-3" } as NodeJS.ProcessEnv), /positive integer/);
  assert.throws(() => mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "1.5" } as NodeJS.ProcessEnv), /positive integer/);
  assert.throws(() => mutationBudgetFromEnv({ WORKFLOW_MUTATION_BUDGET: "lots" } as NodeJS.ProcessEnv), /positive integer/);
});