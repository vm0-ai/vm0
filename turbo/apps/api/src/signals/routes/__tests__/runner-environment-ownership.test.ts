import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runContextSnapshotForRun(runId: string): Record<string, unknown> {
  for (const [dataset, events] of context.mocks.axiom.ingest.mock.calls) {
    if (dataset !== "run-context" || !Array.isArray(events)) {
      continue;
    }
    const snapshot = events.find((event) => {
      return isRecord(event) && event.runId === runId;
    });
    if (isRecord(snapshot)) {
      return snapshot;
    }
  }
  throw new Error(`Expected a run-context snapshot for ${runId}`);
}

describe("runner environment ownership", () => {
  it("removes untrusted OKOU entries before dual-carrying platform environment", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    const untrustedSecretValue = "api-untrusted-secret-value";
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);

    const agentName = `environment-ownership-${randomUUID().slice(0, 8)}`;
    const agent = await runs.createDirectAgent(actor, {
      version: "1",
      agents: {
        [agentName]: {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "bdd-inline-key",
            USER_VALUE: "user-value",
            OKOU_UNTRUSTED_LITERAL: "untrusted-literal-value",
            OKOU_UNTRUSTED_SECRET: `\${{ secrets.OKOU_UNTRUSTED_SECRET }}`,
          },
        },
      },
    });
    const run = await runs.createDirectRun(actor, {
      agentId: agent.agentId,
      prompt: "exercise environment ownership",
      modelProviderType: "anthropic-api-key",
      secrets: { OKOU_UNTRUSTED_SECRET: untrustedSecretValue },
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);

    expect(claim.environment).toMatchObject({ USER_VALUE: "user-value" });
    expect(claim.environment).not.toHaveProperty("OKOU_UNTRUSTED_LITERAL");
    expect(claim.environment).not.toHaveProperty("OKOU_UNTRUSTED_SECRET");
    expect(claim.secretValues ?? []).not.toContain(untrustedSecretValue);
    expect(claim.platformEnvironment).toMatchObject({
      CLI_PKG_URL: expect.any(String),
    });
    for (const [key, value] of Object.entries(
      claim.platformEnvironment ?? {},
    )) {
      expect(claim.environment?.[key]).toBe(value);
    }

    const snapshot = runContextSnapshotForRun(run.runId);
    expect(snapshot.secretNames).toContain("OKOU_UNTRUSTED_SECRET");
    expect(snapshot.environmentEntries).not.toContainEqual(
      expect.objectContaining({ name: "OKOU_UNTRUSTED_LITERAL" }),
    );
    expect(snapshot.environmentEntries).not.toContainEqual(
      expect.objectContaining({ name: "OKOU_UNTRUSTED_SECRET" }),
    );
    expect(JSON.stringify(snapshot)).not.toContain(untrustedSecretValue);

    await runs.requestCancelRun(actor, run.runId, [200]);
  });
});
