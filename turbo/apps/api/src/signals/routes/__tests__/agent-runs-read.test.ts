import { randomUUID } from "node:crypto";

import {
  runsByIdContract,
  runsMainContract,
  runsQueueContract,
} from "@vm0/api-contracts/contracts/runs";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function createFixture(): Promise<UsageInsightFixture> {
  const fixture = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function createCompose(args: {
  readonly fixture: UsageInsightFixture;
  readonly name?: string;
}): Promise<{ readonly composeId: string }> {
  return await store.set(
    seedCompose$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      name: args.name,
    },
    context.signal,
  );
}

async function cacheUserEmail(args: {
  readonly userId: string;
  readonly email: string;
}): Promise<void> {
  await store.set(writeDb$).insert(userCache).values(args);
}

function runsClient() {
  return setupApp({ context })(runsMainContract);
}

function runByIdClient() {
  return setupApp({ context })(runsByIdContract);
}

function queueClient() {
  return setupApp({ context })(runsQueueContract);
}

describe("GET /api/agent/runs", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      runsClient().list({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("uses queued, pending, and running as the default status filter", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture });

    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "queued",
        prompt: "queued run",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "pending",
        prompt: "pending run",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "running",
        prompt: "running run",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "completed",
        prompt: "completed run",
      },
      context.signal,
    );

    const response = await accept(
      runsClient().list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const prompts = response.body.runs.map((run) => {
      return run.prompt;
    });
    expect(prompts).toStrictEqual(
      expect.arrayContaining(["queued run", "pending run", "running run"]),
    );
    expect(prompts).not.toContain("completed run");
  });

  it("returns 400 for invalid status and invalid date filters", async () => {
    const fixture = await createFixture();

    const invalidStatus = await accept(
      runsClient().list({
        query: { status: "running,invalid" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalidStatus.body.error.message).toContain(
      "Invalid status: invalid",
    );

    const invalidSince = await accept(
      runsClient().list({
        query: { since: "not-a-date" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalidSince.body.error.message).toBe(
      "Invalid since timestamp format",
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const invalidUntil = await accept(
      runsClient().list({
        query: { until: "not-a-date" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalidUntil.body.error.message).toBe(
      "Invalid until timestamp format",
    );
  });

  it("filters by agent name, active org, date range, and limit", async () => {
    const fixture = await createFixture();
    const targetCompose = await createCompose({
      fixture,
      name: "target-agent",
    });
    const otherCompose = await createCompose({ fixture, name: "other-agent" });
    const otherOrg = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    await track(
      Promise.resolve({ orgId: otherOrg.orgId, userId: fixture.userId }),
    );
    const otherOrgCompose = await store.set(
      seedCompose$,
      {
        orgId: otherOrg.orgId,
        userId: otherOrg.userId,
        name: "target-agent",
      },
      context.signal,
    );

    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: targetCompose.composeId,
        status: "running",
        prompt: "older target",
        createdAt: new Date("2026-05-12T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: targetCompose.composeId,
        status: "running",
        prompt: "newer target",
        createdAt: new Date("2026-05-12T00:02:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: otherCompose.composeId,
        status: "running",
        prompt: "wrong agent",
        createdAt: new Date("2026-05-12T00:03:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: otherOrg.orgId,
        userId: otherOrg.userId,
        composeId: otherOrgCompose.composeId,
        status: "running",
        prompt: "wrong org",
        createdAt: new Date("2026-05-12T00:04:00.000Z"),
      },
      context.signal,
    );

    const response = await accept(
      runsClient().list({
        query: {
          status: "running",
          agent: "target-agent",
          since: "2026-05-12T00:00:30.000Z",
          until: "2026-05-12T00:03:30.000Z",
          limit: 1,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.prompt).toBe("newer target");
    expect(response.body.runs[0]?.agentName).toBe("target-agent");
  });

  it("accepts sandbox tokens for list reads", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture });
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "running",
        prompt: "sandbox visible",
      },
      context.signal,
    );

    const response = await accept(
      runsClient().list({
        query: { status: "running" },
        headers: {
          authorization: `Bearer ${sandboxToken(fixture)}`,
        },
      }),
      [200],
    );

    expect(
      response.body.runs.map((run) => {
        return run.prompt;
      }),
    ).toContain("sandbox visible");
  });
});

describe("GET /api/agent/runs/:id", () => {
  it("returns 400 when id is not a valid UUID", async () => {
    const fixture = await createFixture();

    const response = await accept(
      runByIdClient().getById({
        params: { id: "2b9b2303" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    mocks.clerk.session(fixture.userId, fixture.orgId);
  });

  it("returns 404 when the run is missing, owned by another user, or in another org", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture });
    const otherUserId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId: fixture.orgId, userId: otherUserId }));
    const otherUserRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        composeId: compose.composeId,
        status: "running",
      },
      context.signal,
    );
    const otherOrg = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherOrgCompose = await store.set(
      seedCompose$,
      {
        orgId: otherOrg.orgId,
        userId: fixture.userId,
      },
      context.signal,
    );
    const otherOrgRun = await store.set(
      seedRun$,
      {
        orgId: otherOrg.orgId,
        userId: fixture.userId,
        composeId: otherOrgCompose.composeId,
        status: "running",
      },
      context.signal,
    );

    const missing = await accept(
      runByIdClient().getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Agent run not found");

    const wrongUser = await accept(
      runByIdClient().getById({
        params: { id: otherUserRun.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(wrongUser.body.error.message).toBe("Agent run not found");

    const wrongOrg = await accept(
      runByIdClient().getById({
        params: { id: otherOrgRun.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(wrongOrg.body.error.message).toBe("Agent run not found");
  });

  it("returns run details and accepts sandbox tokens", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture });
    const { runId } = await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "completed",
        prompt: "detail prompt",
        result: {
          output: "done",
          executionTimeMs: 123,
          conversationId: randomUUID(),
        },
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
        completedAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );

    const response = await accept(
      runByIdClient().getById({
        params: { id: runId },
        headers: { authorization: `Bearer ${sandboxToken(fixture)}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      runId,
      status: "completed",
      prompt: "detail prompt",
      result: {
        output: "done",
        executionTimeMs: 123,
      },
      startedAt: "2026-05-12T00:00:00.000Z",
      completedAt: "2026-05-12T00:01:00.000Z",
    });
  });
});

describe("GET /api/agent/runs/queue", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      queueClient().getQueue({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns an empty queue with concurrency context", async () => {
    const fixture = await createFixture();

    const response = await accept(
      queueClient().getQueue({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      concurrency: {
        tier: "free",
        limit: 1,
        active: 0,
        available: 1,
      },
      queue: [],
      runningTasks: [],
      estimatedTimePerRun: null,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
  });

  it("returns FIFO queue entries with privacy filtering and prompt truncation", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture, name: "queue-agent" });
    const otherUserId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId: fixture.orgId, userId: otherUserId }));
    const sessionId = randomUUID();
    await cacheUserEmail({
      userId: fixture.userId,
      email: "queue-owner@example.com",
    });

    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "queued",
        prompt: "a".repeat(250),
        createdAt: new Date("2026-05-12T00:00:00.000Z"),
        continuedFromSessionId: sessionId,
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        composeId: compose.composeId,
        status: "queued",
        prompt: "secret prompt",
        createdAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );

    const response = await accept(
      queueClient().getQueue({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.queue).toHaveLength(2);
    const [ownEntry, otherEntry] = response.body.queue;
    expect(ownEntry).toMatchObject({
      position: 1,
      agentName: "queue-agent",
      isOwner: true,
      userEmail: "queue-owner@example.com",
      prompt: `${"a".repeat(200)}...`,
      sessionLink: `/chat/${sessionId}`,
    });
    expect(otherEntry).toMatchObject({
      position: 2,
      agentName: null,
      userEmail: null,
      runId: null,
      prompt: null,
      triggerSource: null,
      sessionLink: null,
      isOwner: false,
    });
    expect(JSON.stringify(response.body)).not.toContain("secret prompt");
  });

  it("counts active runs only in the active org", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture, name: "active-agent" });
    const otherOrg = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherOrgCompose = await store.set(
      seedCompose$,
      {
        orgId: otherOrg.orgId,
        userId: otherOrg.userId,
        name: "other-org-agent",
      },
      context.signal,
    );

    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "running",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "pending",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: otherOrg.orgId,
        userId: otherOrg.userId,
        composeId: otherOrgCompose.composeId,
        status: "running",
      },
      context.signal,
    );

    const response = await accept(
      queueClient().getQueue({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.concurrency).toMatchObject({
      limit: 1,
      active: 2,
      available: 0,
    });
    expect(response.body.runningTasks).toHaveLength(1);
  });

  it("returns running task privacy and estimated time per run", async () => {
    const fixture = await createFixture();
    const compose = await createCompose({ fixture, name: "runner-agent" });
    const otherUserId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId: fixture.orgId, userId: otherUserId }));

    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "running",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        composeId: compose.composeId,
        status: "running",
        startedAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "completed",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
        completedAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.composeId,
        status: "completed",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
        completedAt: new Date("2026-05-12T00:02:00.000Z"),
      },
      context.signal,
    );

    const response = await accept(
      queueClient().getQueue({
        headers: { authorization: `Bearer ${sandboxToken(fixture)}` },
      }),
      [200],
    );

    expect(response.body.runningTasks).toHaveLength(2);
    expect(
      response.body.runningTasks.some((task) => {
        return task.isOwner && task.runId !== null;
      }),
    ).toBeTruthy();
    expect(
      response.body.runningTasks.some((task) => {
        return !task.isOwner && task.runId === null;
      }),
    ).toBeTruthy();
    expect(response.body.estimatedTimePerRun).toBe(90_000);
  });
});
