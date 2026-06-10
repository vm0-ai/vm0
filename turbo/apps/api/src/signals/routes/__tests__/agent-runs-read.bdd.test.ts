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

// BDD migration of the legacy `agent-runs-read.test.ts`. The
// 13 legacy `it()`s collapse into 4 BDD `it()`s: (1) GET list
// auth boundary + default status filter chain, (2) GET list
// 400 + filter chain (invalid status → invalid since → invalid
// until → agent + date + org + limit → sandbox token), (3) GET
// byId 400/404/200 chain (invalid uuid → missing → wrong
// user → wrong org → 200 detail), (4) GET queue 401 + empty +
// FIFO + active-in-active-org + privacy + estimated time
// chain. The 404-by-id cases use direct DB seeding via
// `seedRun$` (Open Helper Gap — runs are normally created
// through the public POST endpoint, but seeding a `wrong
// user` or `wrong org` run is not user-reachable from any
// API).

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

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
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

describe("BDD GET /api/agent/runs — auth + default filter", () => {
  it("gwt-wt-wt: 401 unauthenticated → 200 default status filter excludes completed runs", async () => {
    const c = runsClient();

    // When + Then: 401.
    const unauth = await accept(c.list({ query: {}, headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with one queued, one pending, one
    // running, and one completed run.
    const fixture = await createFixture();
    const compose = await createCompose({ fixture });
    for (const { status, prompt } of [
      { status: "queued", prompt: "queued run" },
      { status: "pending", prompt: "pending run" },
      { status: "running", prompt: "running run" },
      { status: "completed", prompt: "completed run" },
    ]) {
      await store.set(
        seedRun$,
        {
          ...fixture,
          composeId: compose.composeId,
          status,
          prompt,
        },
        context.signal,
      );
    }

    // When + Then: the default list filter (queued + pending +
    // running) excludes the completed run.
    const list = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const prompts = list.body.runs.map((run) => {
      return run.prompt;
    });
    expect(prompts).toStrictEqual(
      expect.arrayContaining(["queued run", "pending run", "running run"]),
    );
    expect(prompts).not.toContain("completed run");
  });
});

describe("BDD GET /api/agent/runs — 400 + filter chain", () => {
  it("gwt-wt-wt: 400 invalid status → 400 invalid since → 400 invalid until → 200 filters by agent + date range + org + limit → 200 sandbox token accepted", async () => {
    const c = runsClient();
    const fixture = await createFixture();

    // When + Then: 400 for an unknown status token.
    const invalidStatus = await accept(
      c.list({
        query: { status: "running,invalid" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalidStatus.body.error.message).toContain(
      "Invalid status: invalid",
    );

    // When + Then: 400 for a non-date `since`.
    const invalidSince = await accept(
      c.list({
        query: { since: "not-a-date" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalidSince.body.error.message).toBe(
      "Invalid since timestamp format",
    );

    // When + Then: 400 for a non-date `until`.
    const invalidUntil = await accept(
      c.list({
        query: { until: "not-a-date" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalidUntil.body.error.message).toBe(
      "Invalid until timestamp format",
    );

    // Given: two composes in the caller's org (target + other)
    // and one compose in another org; four running runs across
    // them with distinct createdAt timestamps.
    const targetCompose = await createCompose({
      fixture,
      name: "target-agent",
    });
    const otherCompose = await createCompose({
      fixture,
      name: "other-agent",
    });
    const otherOrg = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
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

    // When + Then: the response is exactly the one "newer
    // target" run after applying agent + date range + limit
    // filters.
    const filtered = await accept(
      c.list({
        query: {
          status: "running",
          agent: "target-agent",
          since: "2026-05-12T00:00:30.000Z",
          until: "2026-05-12T00:03:30.000Z",
          limit: 1,
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(filtered.body.runs).toHaveLength(1);
    expect(filtered.body.runs[0]?.prompt).toBe("newer target");
    expect(filtered.body.runs[0]?.agentName).toBe("target-agent");

    // Given: a fresh fixture with a sandbox token.
    const sandboxFx = await createFixture();
    const sandboxCompose = await createCompose({ fixture: sandboxFx });
    await store.set(
      seedRun$,
      {
        ...sandboxFx,
        composeId: sandboxCompose.composeId,
        status: "running",
        prompt: "sandbox visible",
      },
      context.signal,
    );

    // When + Then: the sandbox token can list runs.
    const sandboxResponse = await accept(
      c.list({
        query: { status: "running" },
        headers: {
          authorization: `Bearer ${sandboxToken(sandboxFx)}`,
        },
      }),
      [200],
    );
    expect(
      sandboxResponse.body.runs.map((run) => {
        return run.prompt;
      }),
    ).toContain("sandbox visible");
  });
});

describe("BDD GET /api/agent/runs/:id — 400/404/200 chain", () => {
  it("gwt-wt-wt: 400 invalid uuid → 404 missing → 404 wrong user (same org) → 404 wrong org → 200 run details (sandbox token accepted)", async () => {
    const c = runByIdClient();
    const fixture = await createFixture();

    // When + Then: 400 for a non-UUID id.
    const invalid = await accept(
      c.getById({
        params: { id: "2b9b2303" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalid.body.error.code).toBe("BAD_REQUEST");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // Given: a fresh fixture with a run owned by another user
    // in the same org + a run owned by the same user in a
    // different org.
    const ownerFixture = await createFixture();
    const ownerCompose = await createCompose({ fixture: ownerFixture });
    const otherUserId = `user_${randomUUID()}`;
    await track(
      Promise.resolve({ orgId: ownerFixture.orgId, userId: otherUserId }),
    );
    const otherUserRun = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: otherUserId,
        composeId: ownerCompose.composeId,
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
        userId: ownerFixture.userId,
      },
      context.signal,
    );
    const otherOrgRun = await store.set(
      seedRun$,
      {
        orgId: otherOrg.orgId,
        userId: ownerFixture.userId,
        composeId: otherOrgCompose.composeId,
        status: "running",
      },
      context.signal,
    );

    // When + Then: 404 for a missing run.
    const missing = await accept(
      c.getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Agent run not found");

    // When + Then: 404 for a run owned by another user in the
    // same org.
    const wrongUser = await accept(
      c.getById({
        params: { id: otherUserRun.runId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(wrongUser.body.error.message).toBe("Agent run not found");

    // When + Then: 404 for a run in another org.
    const wrongOrg = await accept(
      c.getById({
        params: { id: otherOrgRun.runId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(wrongOrg.body.error.message).toBe("Agent run not found");

    // Given: a completed run with a prompt + result + timestamps.
    const detailCompose = await createCompose({ fixture: ownerFixture });
    const { runId } = await store.set(
      seedRun$,
      {
        ...ownerFixture,
        composeId: detailCompose.composeId,
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

    // When + Then: 200 with the run details (sandbox token is
    // accepted because the caller's `runByIdContract` accepts
    // any sandbox capability).
    const detail = await accept(
      c.getById({
        params: { id: runId },
        headers: { authorization: `Bearer ${sandboxToken(ownerFixture)}` },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
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

describe("BDD GET /api/agent/runs/queue — 401 + queue chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 200 empty queue + concurrency context → 200 FIFO with privacy filtering + prompt truncation → 200 active counts only in active org → 200 running task privacy + estimated time per run", async () => {
    const c = queueClient();

    // When + Then: 401.
    const unauth = await accept(c.getQueue({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fresh fixture, no runs.
    const emptyFixture = await createFixture();

    // When + Then: 200 with empty queue + free tier
    // concurrency context.
    const empty = await accept(c.getQueue({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({
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
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // Given: a queue with one of the caller's queued runs
    // (long prompt + session link) and one queued run owned
    // by another user in the same org (must be hidden behind
    // privacy filter).
    const fifoFixture = await createFixture();
    const fifoCompose = await createCompose({
      fixture: fifoFixture,
      name: "queue-agent",
    });
    const otherUserId = `user_${randomUUID()}`;
    await track(
      Promise.resolve({ orgId: fifoFixture.orgId, userId: otherUserId }),
    );
    const sessionId = randomUUID();
    await cacheUserEmail({
      userId: fifoFixture.userId,
      email: "queue-owner@example.com",
    });
    await store.set(
      seedRun$,
      {
        ...fifoFixture,
        composeId: fifoCompose.composeId,
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
        orgId: fifoFixture.orgId,
        userId: otherUserId,
        composeId: fifoCompose.composeId,
        status: "queued",
        prompt: "secret prompt",
        createdAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );

    // When + Then: own entry is fully visible; the other-user
    // entry is privacy-filtered; the secret prompt never
    // appears in the response.
    const fifo = await accept(c.getQueue({ headers: authHeaders() }), [200]);
    expect(fifo.body.queue).toHaveLength(2);
    const [ownEntry, otherEntry] = fifo.body.queue;
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
    expect(JSON.stringify(fifo.body)).not.toContain("secret prompt");

    // Given: a fresh fixture with one running + one pending in
    // the active org + one running in another org.
    const activeFixture = await createFixture();
    const activeCompose = await createCompose({
      fixture: activeFixture,
      name: "active-agent",
    });
    const otherActiveOrg = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherActiveOrgCompose = await store.set(
      seedCompose$,
      {
        orgId: otherActiveOrg.orgId,
        userId: otherActiveOrg.userId,
        name: "other-org-agent",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...activeFixture,
        composeId: activeCompose.composeId,
        status: "running",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...activeFixture,
        composeId: activeCompose.composeId,
        status: "pending",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: otherActiveOrg.orgId,
        userId: otherActiveOrg.userId,
        composeId: otherActiveOrgCompose.composeId,
        status: "running",
      },
      context.signal,
    );

    // When + Then: active count is 2 (the cross-org running
    // run is excluded) and `runningTasks` has 1 entry.
    const active = await accept(c.getQueue({ headers: authHeaders() }), [200]);
    expect(active.body.concurrency).toMatchObject({
      limit: 1,
      active: 2,
      available: 0,
    });
    expect(active.body.runningTasks).toHaveLength(1);

    // Given: a fresh fixture with one running run owned by
    // the caller, one running run owned by another user, and
    // two completed runs (whose durations contribute to
    // `estimatedTimePerRun`).
    const etaFixture = await createFixture();
    const etaCompose = await createCompose({
      fixture: etaFixture,
      name: "runner-agent",
    });
    const etaOtherUserId = `user_${randomUUID()}`;
    await track(
      Promise.resolve({ orgId: etaFixture.orgId, userId: etaOtherUserId }),
    );
    await store.set(
      seedRun$,
      {
        ...etaFixture,
        composeId: etaCompose.composeId,
        status: "running",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: etaFixture.orgId,
        userId: etaOtherUserId,
        composeId: etaCompose.composeId,
        status: "running",
        startedAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...etaFixture,
        composeId: etaCompose.composeId,
        status: "completed",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
        completedAt: new Date("2026-05-12T00:01:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        ...etaFixture,
        composeId: etaCompose.composeId,
        status: "completed",
        startedAt: new Date("2026-05-12T00:00:00.000Z"),
        completedAt: new Date("2026-05-12T00:02:00.000Z"),
      },
      context.signal,
    );

    // When + Then: the running task list has 2 entries (one
    // visible to the owner, one privacy-filtered for the
    // other user), and `estimatedTimePerRun` is the average
    // of the two completed run durations (60s + 120s) / 2 =
    // 90s.
    const eta = await accept(
      c.getQueue({
        headers: { authorization: `Bearer ${sandboxToken(etaFixture)}` },
      }),
      [200],
    );
    expect(eta.body.runningTasks).toHaveLength(2);
    expect(
      eta.body.runningTasks.some((task) => {
        return task.isOwner && task.runId !== null;
      }),
    ).toBeTruthy();
    expect(
      eta.body.runningTasks.some((task) => {
        return !task.isOwner && task.runId === null;
      }),
    ).toBeTruthy();
    expect(eta.body.estimatedTimePerRun).toBe(90_000);
  });
});
