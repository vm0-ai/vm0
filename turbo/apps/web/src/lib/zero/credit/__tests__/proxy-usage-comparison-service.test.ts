import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
import { compareRecentRunsProxyUsage } from "../proxy-usage-comparison-service";
import {
  createCompletedRun,
  insertTestCreditUsageForRun,
  insertTestClientCreditUsage,
} from "../../../../__tests__/api-test-helpers";
import { logger } from "../../../shared/logger";

const context = testContext();

function errorMessagesForOrg(
  spy: MockInstance,
  orgId: string,
): Array<{ message: string; meta: Record<string, unknown> }> {
  return spy.mock.calls
    .map((call) => {
      return {
        message: call[0] as string,
        meta: call[1] as Record<string, unknown>,
      };
    })
    .filter((entry) => {
      return entry.meta.orgId === orgId;
    });
}

describe("compareRecentRunsProxyUsage", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    context.setupMocks();
    logSpy = vi.spyOn(logger("service:proxy-usage-comparison"), "error");
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── Time window ────────────────────────────────────────────────────

  it("does nothing when no runs in window", async () => {
    const { orgId } = await context.setupUser({ prefix: "empty" });
    await compareRecentRunsProxyUsage();
    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("skips runs completed less than 30s ago", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "recent" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 10_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 30,
    });
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("skips runs completed more than 5m30s ago", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "old" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 360_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 30,
    });
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  // ── Divergence cases ───────────────────────────────────────────────

  it("logs 'undercount' when proxy < client on any field", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "under" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    // Proxy side: low input tokens
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 30,
      outputTokens: 50,
    });
    // Client side: higher input tokens
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
      outputTokens: 50,
    });

    await compareRecentRunsProxyUsage();

    const entries = errorMessagesForOrg(logSpy, orgId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Proxy usage undercount");
    expect(entries[0]!.meta).toMatchObject({
      runId,
      field: "inputTokens",
      proxyValue: 30,
      clientValue: 100,
    });
  });

  it("does not log when proxy > client (subagent gap is expected)", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "over" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    // Proxy has more (captured subagent calls client doesn't see)
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 200,
    });
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("does not log when proxy and client match", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "match" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 100,
      outputTokens: 50,
    });
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
      outputTokens: 50,
    });

    await compareRecentRunsProxyUsage();

    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  // ── Missing-side cases (strict union check) ────────────────────────

  it("logs 'missing proxy' when client has data but proxy has none", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "no-proxy" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    const entries = errorMessagesForOrg(logSpy, orgId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe(
      "Proxy usage missing for run with client data",
    );
    expect(entries[0]!.meta).toMatchObject({ runId });
  });

  it("logs 'missing client' when proxy has data but client has none", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "no-client" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    const entries = errorMessagesForOrg(logSpy, orgId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe(
      "Client usage missing for run with proxy data",
    );
    expect(entries[0]!.meta).toMatchObject({ runId });
  });

  // ── Multi-row proxy aggregates subagent usage ──────────────────────

  it("aggregates multiple proxy rows (subagents) per run for comparison", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "multi" });
    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    // Three proxy rows (main + 2 subagent calls), summing to 120 input tokens
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      messageId: "msg_main",
      inputTokens: 60,
    });
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      messageId: "msg_sub1",
      inputTokens: 30,
    });
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      messageId: "msg_sub2",
      inputTokens: 30,
    });
    // Client sees only main (60)
    await insertTestClientCreditUsage(orgId, {
      userId,
      runId,
      inputTokens: 60,
    });

    await compareRecentRunsProxyUsage();

    // Proxy sum (120) > client (60) → no undercount alert
    expect(errorMessagesForOrg(logSpy, orgId)).toHaveLength(0);
  });

  // ── Multiple orgs ──────────────────────────────────────────────────

  it("isolates alerts per org", async () => {
    const user1 = await context.setupUser({ prefix: "org1" });
    const user2 = await context.setupUser({ prefix: "org2" });
    const completedAt = new Date(Date.now() - 120_000);

    // Org1: match, no alert
    const run1 = await createCompletedRun(
      user1.orgId,
      user1.userId,
      completedAt,
    );
    await insertTestCreditUsageForRun({
      runId: run1,
      orgId: user1.orgId,
      userId: user1.userId,
      inputTokens: 100,
    });
    await insertTestClientCreditUsage(user1.orgId, {
      userId: user1.userId,
      runId: run1,
      inputTokens: 100,
    });

    // Org2: proxy undercount, 1 alert
    const run2 = await createCompletedRun(
      user2.orgId,
      user2.userId,
      completedAt,
    );
    await insertTestCreditUsageForRun({
      runId: run2,
      orgId: user2.orgId,
      userId: user2.userId,
      inputTokens: 30,
    });
    await insertTestClientCreditUsage(user2.orgId, {
      userId: user2.userId,
      runId: run2,
      inputTokens: 100,
    });

    await compareRecentRunsProxyUsage();

    expect(errorMessagesForOrg(logSpy, user1.orgId)).toHaveLength(0);
    expect(errorMessagesForOrg(logSpy, user2.orgId)).toHaveLength(1);
  });
});
