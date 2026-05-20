import { randomUUID } from "node:crypto";

import {
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
} from "@vm0/api-contracts/contracts/runners";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import { createStore } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signPatJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { encryptSecretValue } from "../../services/crypto.utils";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const OFFICIAL_RUNNER_TOKEN =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

interface PatFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function runnerHeartbeatBody(runnerId: string) {
  return {
    runnerId,
    runnerName: "test-runner",
    group: "vm0/test",
    profiles: ["vm0/default"],
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: 4,
    allocatedVcpu: 2,
    allocatedMemoryMb: 4096,
    runningCount: 1,
    heldSessions: ["session-1"],
    mode: "running" as const,
  };
}

function storedExecutionContext(secretValue: string) {
  return {
    workingDir: "/workspace",
    storageManifest: null,
    environment: {
      API_KEY: secretValue,
      OTHER_VALUE: "not-a-secret",
    },
    resumeSession: null,
    encryptedSecrets: encryptSecretValue(
      JSON.stringify({
        API_KEY: secretValue,
        UNUSED_SECRET: "hidden",
      }),
    ),
    cliAgentType: "claude-code",
    apiStartTime: now() - 1000,
  };
}

async function seedPatFixture(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<PatFixture> {
  const tokenId = randomUUID();
  const seconds = currentSecond();
  const token = signPatJwtForTests({
    scope: "cli",
    userId: args.userId,
    orgId: args.orgId,
    tokenId,
    iat: seconds,
    exp: seconds + 60,
  });
  const db = store.set(writeDb$);
  await db.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: args.userId,
    name: "runner token",
    expiresAt: new Date(now() + 60_000),
  });

  return { token, tokenId, userId: args.userId, orgId: args.orgId };
}

async function seedExpiredPatFixture(args: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<PatFixture> {
  const tokenId = randomUUID();
  const seconds = currentSecond();
  const token = signPatJwtForTests({
    scope: "cli",
    userId: args.userId,
    orgId: args.orgId,
    tokenId,
    iat: seconds - 120,
    exp: seconds - 60,
  });
  const db = store.set(writeDb$);
  await db.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: args.userId,
    name: "expired runner token",
    expiresAt: new Date(now() - 60_000),
  });

  return { token, tokenId, userId: args.userId, orgId: args.orgId };
}

async function seedQueuedRun(args: {
  readonly fixture: UsageInsightFixture;
  readonly runnerGroup?: string;
  readonly profile?: string;
  readonly sessionId?: string | null;
  readonly secretValue?: string;
}): Promise<{ readonly runId: string; readonly composeVersionId: string }> {
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: args.fixture.orgId, userId: args.fixture.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      composeId,
      status: "pending",
      prompt: "queued prompt",
    },
    context.signal,
  );
  const db = store.set(writeDb$);
  const [run] = await db
    .select({ agentComposeVersionId: agentRuns.agentComposeVersionId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  await db.insert(runnerJobQueue).values({
    runId,
    runnerGroup: args.runnerGroup ?? "vm0/test",
    profile: args.profile ?? "vm0/default",
    sessionId: args.sessionId ?? null,
    executionContext: storedExecutionContext(
      args.secretValue ?? "super-secret",
    ),
    expiresAt: new Date(now() + 60_000),
  });

  return { runId, composeVersionId: run?.agentComposeVersionId ?? "" };
}

describe("POST /api/runners/*", () => {
  const trackUsageFixture = createFixtureTracker<UsageInsightFixture>(
    (fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    },
  );
  const patFixtures: PatFixture[] = [];
  const runnerStateIds: string[] = [];

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (patFixtures.length > 0) {
      const fixture = patFixtures.pop();
      if (fixture) {
        await db.delete(cliTokens).where(eq(cliTokens.id, fixture.tokenId));
      }
    }
    if (runnerStateIds.length > 0) {
      await db
        .delete(runnerState)
        .where(inArray(runnerState.runnerId, [...runnerStateIds]));
      runnerStateIds.length = 0;
    }
  });

  it("rejects unauthenticated heartbeat requests", async () => {
    const client = setupApp({ context })(runnersHeartbeatContract);
    const response = await accept(
      client.heartbeat({
        body: runnerHeartbeatBody(randomUUID()),
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects heartbeat requests for non-vm0 runner groups", async () => {
    const client = setupApp({ context })(runnersHeartbeatContract);
    const response = await accept(
      client.heartbeat({
        body: {
          ...runnerHeartbeatBody(randomUUID()),
          group: "other/test",
        },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid runner group", code: "BAD_REQUEST" },
    });
  });

  it("records runner heartbeat and removes stale runner state", async () => {
    const staleRunnerId = randomUUID();
    const activeRunnerId = randomUUID();
    runnerStateIds.push(staleRunnerId, activeRunnerId);
    const db = store.set(writeDb$);
    await db.insert(runnerState).values({
      runnerId: staleRunnerId,
      runnerName: "stale-runner",
      runnerGroup: "vm0/test",
      profiles: ["vm0/default"],
      totalVcpu: 1,
      totalMemoryMb: 512,
      maxConcurrent: 1,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      heldSessions: [],
      mode: "running",
      lastSeenAt: new Date(now() - 6 * 60 * 1000),
    });

    const client = setupApp({ context })(runnersHeartbeatContract);
    const response = await accept(
      client.heartbeat({
        body: runnerHeartbeatBody(activeRunnerId),
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    const rows = await db
      .select({
        runnerId: runnerState.runnerId,
        runnerName: runnerState.runnerName,
        runningCount: runnerState.runningCount,
      })
      .from(runnerState)
      .where(inArray(runnerState.runnerId, [staleRunnerId, activeRunnerId]));
    expect(rows).toStrictEqual([
      {
        runnerId: activeRunnerId,
        runnerName: "test-runner",
        runningCount: 1,
      },
    ]);
  });

  it("returns a pending job for a runner poll", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const pat = await seedPatFixture({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    patFixtures.push(pat);
    const queued = await seedQueuedRun({ fixture, sessionId: "session-a" });

    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: {
          group: "vm0/test",
          profiles: ["vm0/default"],
          heldSessions: ["session-a"],
        },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      job: {
        runId: queued.runId,
        prompt: "queued prompt",
        appendSystemPrompt: null,
        agentComposeVersionId: queued.composeVersionId,
        vars: null,
        checkpointId: null,
        experimentalProfile: "vm0/default",
      },
    });
  });

  it("returns an affinity-matching poll job first when heldSessions is provided", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const runnerGroup = `vm0/poll-${randomUUID()}`;
    await seedQueuedRun({ fixture, runnerGroup });
    const affinityJob = await seedQueuedRun({
      fixture,
      runnerGroup,
      sessionId: "session-X",
    });

    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: {
          group: runnerGroup,
          heldSessions: ["session-X"],
        },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body.job?.runId).toBe(affinityJob.runId);
  });

  it("returns a poll job when heldSessions has no match", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const runnerGroup = `vm0/poll-${randomUUID()}`;
    const queued = await seedQueuedRun({ fixture, runnerGroup });

    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: {
          group: runnerGroup,
          heldSessions: ["session-no-match"],
        },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body.job?.runId).toBe(queued.runId);
  });

  it("returns a poll job when heldSessions is empty", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const runnerGroup = `vm0/poll-${randomUUID()}`;
    const queued = await seedQueuedRun({ fixture, runnerGroup });

    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: {
          group: runnerGroup,
          heldSessions: [],
        },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body.job?.runId).toBe(queued.runId);
  });

  it("returns a poll job when heldSessions is omitted", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const runnerGroup = `vm0/poll-${randomUUID()}`;
    const queued = await seedQueuedRun({ fixture, runnerGroup });

    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: { group: runnerGroup },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body.job?.runId).toBe(queued.runId);
  });

  it("returns null when no poll jobs exist for the group", async () => {
    const client = setupApp({ context })(runnersPollContract);
    const response = await accept(
      client.poll({
        body: {
          group: `vm0/poll-${randomUUID()}`,
          heldSessions: ["session-X"],
        },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ job: null });
  });

  it("claims a queued job and returns prepared execution context", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const pat = await seedPatFixture({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    patFixtures.push(pat);
    const queued = await seedQueuedRun({
      fixture,
      secretValue: "runner-visible-secret",
    });

    const client = setupApp({ context })(runnersJobClaimContract);
    const response = await accept(
      client.claim({
        params: { id: queued.runId },
        body: {},
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      runId: queued.runId,
      prompt: "queued prompt",
      workingDir: "/workspace",
      cliAgentType: "claude-code",
      environment: {
        API_KEY: "runner-visible-secret",
        OTHER_VALUE: "not-a-secret",
      },
      secretValues: ["runner-visible-secret"],
    });
    expect(response.body.sandboxToken).toMatch(/^vm0_sandbox_/);

    const db = store.set(writeDb$);
    const [run] = await db
      .select({
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.runId));
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBeInstanceOf(Date);
    expect(run?.lastHeartbeatAt).toBeInstanceOf(Date);

    const remainingJobs = await db
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queued.runId));
    expect(remainingJobs).toHaveLength(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${queued.runId}`,
      { status: "running" },
    );
  });

  it("prevents a user runner from claiming another user's job", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const queued = await seedQueuedRun({ fixture });
    const pat = await seedPatFixture({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    patFixtures.push(pat);

    const client = setupApp({ context })(runnersJobClaimContract);
    const response = await accept(
      client.claim({
        params: { id: queued.runId },
        body: {},
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Job does not belong to user", code: "FORBIDDEN" },
    });
  });

  it("generates a subscribe-only realtime token for a runner group", async () => {
    const tokenRequest = {
      keyName: "test-key",
      timestamp: 1_700_000_000_000,
      capability: '{"runner-group:vm0/test":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);

    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [200],
    );

    expect(response.body).toStrictEqual(tokenRequest);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        "runner-group:vm0/test": ["subscribe"],
      },
      ttl: 3_600_000,
    });
  });

  it("generates a realtime token for a user runner", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const pat = await seedPatFixture({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    patFixtures.push(pat);
    const tokenRequest = {
      keyName: "test-key",
      timestamp: 1_700_000_000_000,
      capability: '{"runner-group:vm0/production":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);

    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/production" },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual(tokenRequest);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        "runner-group:vm0/production": ["subscribe"],
      },
      ttl: 3_600_000,
    });
  });

  it("rejects realtime token requests with no authorization", async () => {
    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("rejects realtime token requests with non-Bearer authorization", async () => {
    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: { authorization: "Basic sometoken" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("rejects realtime token requests with an invalid CLI token", async () => {
    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: { authorization: "Bearer invalid_nonexistent_token" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("rejects realtime token requests with an expired CLI token", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const pat = await seedExpiredPatFixture({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    patFixtures.push(pat);

    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("rejects realtime token requests for non-vm0 runner groups", async () => {
    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "other/test" },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Official runners can only subscribe to vm0/* groups",
        code: "FORBIDDEN",
      },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("rejects user realtime token requests for non-vm0 runner groups", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const pat = await seedPatFixture({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    patFixtures.push(pat);

    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "wrong-org/default" },
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only vm0/* runner groups are supported",
        code: "FORBIDDEN",
      },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("returns an internal error when realtime token generation fails", async () => {
    const error = new Error("Token gen failed");
    context.mocks.ably.createTokenRequest.mockRejectedValueOnce(error);

    const client = setupApp({ context })(runnerRealtimeTokenContract);
    const response = await accept(
      client.create({
        body: { group: "vm0/test" },
        headers: { authorization: OFFICIAL_RUNNER_TOKEN },
      }),
      [500],
    );

    expect(response.status).toBe(500);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });
});
