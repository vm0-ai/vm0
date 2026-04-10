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
  insertTestProxyCreditUsage,
} from "../../../../__tests__/api-test-helpers";
import { logger } from "../../../shared/logger";

const context = testContext();

/** Filter logSpy calls to only those matching a specific orgId. */
function callsForOrg(
  spy: MockInstance,
  orgId: string,
): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => {
      return call[0] === "Proxy usage undercount";
    })
    .map((call) => {
      return call[1] as Record<string, unknown>;
    })
    .filter((meta) => {
      return meta.orgId === orgId;
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

  it("does nothing when no runs in window", async () => {
    const { orgId } = await context.setupUser({ prefix: "empty" });
    await compareRecentRunsProxyUsage();
    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
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
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId,
      orgId,
      userId,
      inputTokens: 200,
    });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
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
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId,
      orgId,
      userId,
      inputTokens: 200,
    });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("logs error when proxy undercount (proxy < client)", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "under" });

    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId,
      orgId,
      userId,
      inputTokens: 30,
      outputTokens: 50,
    });

    await compareRecentRunsProxyUsage();

    const calls = callsForOrg(logSpy, orgId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId,
      field: "inputTokens",
      clientValue: 100,
      proxyValue: 30,
    });
  });

  it("does not log when proxy overcounts (subagent usage)", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "over" });

    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId,
      orgId,
      userId,
      inputTokens: 200,
      outputTokens: 50,
    });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("does not log when usage matches", async () => {
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
      status: "processed",
    });
    await insertTestProxyCreditUsage({ runId, orgId, userId });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("skips run with client data but no proxy data", async () => {
    const { orgId, userId } = await context.setupUser({ prefix: "no-proxy" });

    const runId = await createCompletedRun(
      orgId,
      userId,
      new Date(Date.now() - 120_000),
    );
    await insertTestCreditUsageForRun({
      runId,
      orgId,
      userId,
      status: "processed",
    });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, orgId)).toHaveLength(0);
  });

  it("handles multiple orgs in one window", async () => {
    const user1 = await context.setupUser({ prefix: "org1" });
    const user2 = await context.setupUser({ prefix: "org2" });

    const completedAt = new Date(Date.now() - 120_000);

    const run1 = await createCompletedRun(
      user1.orgId,
      user1.userId,
      completedAt,
    );
    await insertTestCreditUsageForRun({
      runId: run1,
      orgId: user1.orgId,
      userId: user1.userId,
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId: run1,
      orgId: user1.orgId,
      userId: user1.userId,
    });

    const run2 = await createCompletedRun(
      user2.orgId,
      user2.userId,
      completedAt,
    );
    await insertTestCreditUsageForRun({
      runId: run2,
      orgId: user2.orgId,
      userId: user2.userId,
      status: "processed",
    });
    await insertTestProxyCreditUsage({
      runId: run2,
      orgId: user2.orgId,
      userId: user2.userId,
      inputTokens: 30,
    });

    await compareRecentRunsProxyUsage();

    expect(callsForOrg(logSpy, user1.orgId)).toHaveLength(0);
    expect(callsForOrg(logSpy, user2.orgId)).toHaveLength(1);
  });
});
