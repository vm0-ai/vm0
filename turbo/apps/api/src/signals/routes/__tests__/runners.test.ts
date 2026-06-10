// Remnant legacy file, kept per api.bdd.md "Unreachable Code Candidates"
// (firewall-auth precedent): the claim-conflict 409 family (runners.ts:340)
// and the poison-job families (failPoisonQueuedJob, scheduleClaimFailedSideEffects$,
// and the claim-side poison arms) are only constructible via direct DB writes —
// no public API sets runner_job_queue.claimed_at or stores a schema-invalid
// execution context. Route-level runner coverage lives in
// run-lifecycle.bdd.test.ts (RUN-03).
import {
  runnersJobClaimContract,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
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

function encryptedSecretsMap(values: Record<string, string>): string {
  return encryptSecretForTests(JSON.stringify(values));
}

function storedExecutionContext(
  overrides?: Partial<StoredExecutionContext>,
): StoredExecutionContext {
  return {
    storageManifest: null,
    environment: {
      API_KEY: "super-secret",
      OTHER_VALUE: "not-a-secret",
    },
    resumeSession: null,
    encryptedSecrets: encryptedSecretsMap({
      API_KEY: "super-secret",
      UNUSED_SECRET: "hidden",
    }),
    cliAgentType: "claude-code",
    apiStartTime: now() - 1000,
    ...overrides,
  };
}

async function seedQueuedRun(args: {
  readonly fixture: UsageInsightFixture;
  readonly contextOverrides?: Partial<StoredExecutionContext>;
}): Promise<{ readonly runId: string }> {
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
  await db.insert(runnerJobQueue).values({
    runId,
    runnerGroup: "vm0/test",
    profile: "vm0/default",
    sessionId: null,
    executionContext: storedExecutionContext(args.contextOverrides),
    expiresAt: new Date(now() + 60_000),
  });

  return { runId };
}

function claimRunnerJob(args: {
  readonly runId: string;
  readonly status: 400 | 409;
}) {
  const client = setupApp({ context })(runnersJobClaimContract);
  return accept(
    client.claim({
      params: { id: args.runId },
      body: {},
      headers: { authorization: OFFICIAL_RUNNER_TOKEN },
    }),
    [args.status],
  );
}

describe("POST /api/runners/* (remnant: DB-seeded claim-conflict and poison jobs)", () => {
  const trackUsageFixture = createFixtureTracker<UsageInsightFixture>(
    (fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    },
  );

  it("returns a conflict when a queued job is already claimed", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const queued = await seedQueuedRun({ fixture });
    const db = store.set(writeDb$);
    await db
      .update(runnerJobQueue)
      .set({ claimedAt: new Date(now()) })
      .where(eq(runnerJobQueue.runId, queued.runId));

    const response = await claimRunnerJob({
      runId: queued.runId,
      status: 409,
    });

    expect(response.body).toStrictEqual({
      error: { message: "Job already claimed", code: "CONFLICT" },
    });
  });

  it("fails invalid stored execution context and dequeues the job", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const queued = await seedQueuedRun({
      fixture,
      contextOverrides: { apiStartTime: 1 },
    });

    const response = await claimRunnerJob({
      runId: queued.runId,
      status: 400,
    });

    expect(response.body).toStrictEqual({
      error: {
        message: "Job missing execution context",
        code: "BAD_REQUEST",
      },
    });

    const db = store.set(writeDb$);
    const remainingJobs = await db
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queued.runId));
    expect(remainingJobs).toHaveLength(0);

    const [run] = await db
      .select({
        status: agentRuns.status,
        error: agentRuns.error,
        completedAt: agentRuns.completedAt,
        startedAt: agentRuns.startedAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.runId));
    expect(run).toMatchObject({
      status: "failed",
      error: "Runner job missing valid execution context",
    });
    expect(run?.completedAt).toBeInstanceOf(Date);
    expect(run?.startedAt).toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${queued.runId}`,
      { status: "failed" },
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `run:changed:${queued.runId}`,
      { status: "running" },
    );
  });

  it("fails and dequeues a job with invalid stored execution context", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const queued = await seedQueuedRun({ fixture });
    const db = store.set(writeDb$);
    await db
      .update(runnerJobQueue)
      .set({ executionContext: {} })
      .where(eq(runnerJobQueue.runId, queued.runId));

    const response = await claimRunnerJob({
      runId: queued.runId,
      status: 400,
    });

    expect(response.body).toStrictEqual({
      error: { message: "Job missing execution context", code: "BAD_REQUEST" },
    });
    const [run] = await db
      .select({
        status: agentRuns.status,
        error: agentRuns.error,
        completedAt: agentRuns.completedAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.runId));
    expect(run).toMatchObject({
      status: "failed",
      error: "Runner job missing valid execution context",
    });
    expect(run?.completedAt).toBeInstanceOf(Date);

    const remainingJobs = await db
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, queued.runId));
    expect(remainingJobs).toHaveLength(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${queued.runId}`,
      { status: "failed" },
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `run:changed:${queued.runId}`,
      { status: "running" },
    );
  });

  it("fails invalid stored execution context once under concurrent claims", async () => {
    const fixture = await trackUsageFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const queued = await seedQueuedRun({ fixture });
    const db = store.set(writeDb$);
    await db
      .update(runnerJobQueue)
      .set({ executionContext: {} })
      .where(eq(runnerJobQueue.runId, queued.runId));
    const client = setupApp({ context })(runnersJobClaimContract);

    const responses = await Promise.all(
      [0, 1].map(() => {
        return accept(
          client.claim({
            params: { id: queued.runId },
            body: {},
            headers: { authorization: OFFICIAL_RUNNER_TOKEN },
          }),
          [400, 404, 409],
        );
      }),
    );

    expect(
      responses.filter((response) => {
        return response.status === 400;
      }),
    ).toHaveLength(1);
    const [run] = await db
      .select({ status: agentRuns.status, error: agentRuns.error })
      .from(agentRuns)
      .where(eq(agentRuns.id, queued.runId));
    expect(run).toMatchObject({
      status: "failed",
      error: "Runner job missing valid execution context",
    });
    const failedEvents = context.mocks.ably.publish.mock.calls.filter(
      ([channel, payload]) => {
        const status =
          payload && typeof payload === "object" && "status" in payload
            ? payload.status
            : undefined;
        return channel === `run:changed:${queued.runId}` && status === "failed";
      },
    );
    expect(failedEvents).toHaveLength(1);
  });
});
