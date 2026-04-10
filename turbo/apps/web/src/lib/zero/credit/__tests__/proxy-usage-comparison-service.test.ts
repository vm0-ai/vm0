import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { initServices } from "../../../init-services";
import { compareRecentRunsProxyUsage } from "../proxy-usage-comparison-service";
import { creditUsage } from "../../../../db/schema/credit-usage";
import { proxyCreditUsage } from "../../../../db/schema/proxy-credit-usage";
import { agentRuns } from "../../../../db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../db/schema/agent-compose";
import { logger } from "../../../shared/logger";

const context = testContext();

/** Create a run with a specific completedAt timestamp. Returns runId. */
async function createRun(
  orgId: string,
  userId: string,
  completedAt: Date,
): Promise<string> {
  initServices();
  const db = globalThis.services.db;

  const composeName = `compose-${randomBytes(4).toString("hex")}`;
  const [compose] = await db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning();
  const versionId = randomBytes(32).toString("hex");
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: {},
    createdBy: userId,
  });

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
      completedAt,
    })
    .returning();

  return run!.id;
}

/** Insert a credit_usage row for a run. */
async function insertClientUsage(
  runId: string,
  orgId: string,
  userId: string,
  tokens: { input: number; output: number },
): Promise<void> {
  await globalThis.services.db.insert(creditUsage).values({
    runId,
    orgId,
    userId,
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    status: "processed",
    processedAt: new Date(),
  });
}

/** Insert a proxy_credit_usage row for a run. */
async function insertProxyUsage(
  runId: string,
  orgId: string,
  userId: string,
  tokens: { input: number; output: number },
): Promise<void> {
  await globalThis.services.db.insert(proxyCreditUsage).values({
    runId,
    orgId,
    userId,
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  });
}

describe("compareRecentRunsProxyUsage", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("does nothing when no runs in window", async () => {
    // No runs at all — should not throw
    await compareRecentRunsProxyUsage();
  });

  it("skips runs completed less than 30s ago", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "recent" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    // Run completed 10 seconds ago — inside the 30s floor
    const runId = await createRun(orgId, userId, new Date(Date.now() - 10_000));
    await insertClientUsage(runId, orgId, userId, { input: 100, output: 50 });
    await insertProxyUsage(runId, orgId, userId, { input: 200, output: 50 });

    await compareRecentRunsProxyUsage();

    // Should NOT be compared (too recent)
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("skips runs completed more than 5m30s ago", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "old" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    // Run completed 6 minutes ago — outside the 5m30s ceiling
    const runId = await createRun(
      orgId,
      userId,
      new Date(Date.now() - 360_000),
    );
    await insertClientUsage(runId, orgId, userId, { input: 100, output: 50 });
    await insertProxyUsage(runId, orgId, userId, { input: 200, output: 50 });

    await compareRecentRunsProxyUsage();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("logs error for mismatching usage within window", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "mismatch" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    // Run completed 2 minutes ago — inside window
    const runId = await createRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertClientUsage(runId, orgId, userId, { input: 100, output: 50 });
    await insertProxyUsage(runId, orgId, userId, { input: 200, output: 50 });

    await compareRecentRunsProxyUsage();

    // inputTokens mismatch should be logged
    expect(logSpy).toHaveBeenCalledWith(
      "Proxy usage mismatch",
      expect.objectContaining({
        runId,
        field: "inputTokens",
        clientValue: 100,
        proxyValue: 200,
      }),
    );
    // outputTokens match — should NOT be logged for this field
    const outputCalls = logSpy.mock.calls.filter((call) => {
      const meta = call[1] as Record<string, unknown>;
      return meta.field === "outputTokens";
    });
    expect(outputCalls).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("does not log when usage matches", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "match" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    const runId = await createRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertClientUsage(runId, orgId, userId, { input: 100, output: 50 });
    await insertProxyUsage(runId, orgId, userId, { input: 100, output: 50 });

    await compareRecentRunsProxyUsage();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("skips run with client data but no proxy data", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "no-proxy" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    const runId = await createRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertClientUsage(runId, orgId, userId, { input: 100, output: 50 });
    // No proxy data inserted

    await compareRecentRunsProxyUsage();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("handles multiple orgs in one window", async () => {
    const user1 = await context.setupUser({ prefix: "org1" });
    const user2 = await context.setupUser({ prefix: "org2" });
    const logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");

    const completedAt = new Date(Date.now() - 120_000);

    const run1 = await createRun(user1.orgId, user1.userId, completedAt);
    await insertClientUsage(run1, user1.orgId, user1.userId, {
      input: 100,
      output: 50,
    });
    await insertProxyUsage(run1, user1.orgId, user1.userId, {
      input: 100,
      output: 50,
    });

    const run2 = await createRun(user2.orgId, user2.userId, completedAt);
    await insertClientUsage(run2, user2.orgId, user2.userId, {
      input: 100,
      output: 50,
    });
    await insertProxyUsage(run2, user2.orgId, user2.userId, {
      input: 300,
      output: 50,
    });

    await compareRecentRunsProxyUsage();

    // Only org2's run should have a mismatch
    const calls = logSpy.mock.calls.filter((call) => {
      return call[0] === "Proxy usage mismatch";
    });
    expect(calls).toHaveLength(1);
    expect((calls[0]![1] as Record<string, unknown>).orgId).toBe(user2.orgId);

    logSpy.mockRestore();
  });
});
