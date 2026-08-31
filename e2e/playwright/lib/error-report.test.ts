import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { expect } from "@playwright/test";

import { formatErrorReport } from "./error-report";

function matcherFailure(): unknown {
  try {
    expect("received-value").toBe("expected-value");
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the matcher to fail");
}

function runnerCredentialFailure(): AggregateError {
  const provisioningFailure = new Error(
    "Failed to provision runner E2E credential for runner-real-claude@vm0-e2e.ai (e2e-api-credentials-runner-real-claude.json)",
    { cause: matcherFailure() },
  );
  return new AggregateError([provisioningFailure], provisioningFailure.message);
}

test("runner credential failures report the nested matcher cause", async (context) => {
  const failure = runnerCredentialFailure();

  await context.test("the default inspect depth erases the cause", () => {
    const truncated = inspect(failure, { depth: 2 });
    assert.match(truncated, /\[cause\]: \[ExpectError\]/u);
    assert.doesNotMatch(truncated, /expected-value/u);
  });

  await context.test("the report keeps the whole cause chain", () => {
    const report = formatErrorReport(failure);
    assert.match(report, /Failed to provision runner E2E credential/u);
    assert.match(report, /expect\(received\)\.toBe\(expected\)/u);
    assert.match(report, /expected-value/u);
    assert.match(report, /received-value/u);
  });
});
