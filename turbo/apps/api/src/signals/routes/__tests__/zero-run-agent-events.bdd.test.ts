import { randomUUID } from "node:crypto";

import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-run-agent-events.test.ts`.
// The 8 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (200 owned run with framework=claude-
// code → 200 framework=codex (legacy compose content)
// → 404 unknown → 404 cross-user → 200 lastEventSequence
// waits for watermark + passes noCache → 200 watermark
// null = no poll + no noCache → 403 sandbox without
// `agent-run:read`).
//
// The "framework from legacy compose content" test
// updates `agentComposeVersions.content` directly (the
// compose content is read-only from the public API; the
// legacy test mutated it to simulate a legacy
// deployment). The "watermark" tests verify the
// `context.mocks.axiom.query.mock.calls` to confirm
// the visibility poll + noCache option flow.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunAgentEventsContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/:id/telemetry/agent — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/zero/runs/:id/telemetry/agent — full coverage chain", () => {
  it("gwt-wt-wt: 200 claude-code → 200 codex → 404 unknown → 404 cross-user → 200 watermark waits + noCache → 200 watermark null skips poll → 403 sandbox no capability", async () => {
    // Given: a fresh fixture + an owned running run.
    context.mocks.axiom.query.mockResolvedValue([]);
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "running",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: 200 — default framework is claude-code.
    const claudeCode = await accept(
      c.getAgentEvents({
        params: { id: runId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(claudeCode.body).toStrictEqual({
      events: [],
      hasMore: false,
      framework: "claude-code",
    });

    // Given: a fresh fixture + an owned running run whose
    // compose version uses the legacy `agent: { framework:
    // "codex" }` content (this exercises the legacy
    // single-agent content shape; the route checks
    // `content.agent.framework` first before falling
    // through to the new `content.agents[name].framework`
    // shape).
    const codexFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const codexCompose = await store.set(
      seedCompose$,
      { orgId: codexFixture.orgId, userId: codexFixture.userId },
      context.signal,
    );
    const { runId: codexRunId } = await store.set(
      seedRun$,
      {
        orgId: codexFixture.orgId,
        userId: codexFixture.userId,
        composeId: codexCompose.composeId,
        status: "running",
      },
      context.signal,
    );
    const [codexRunRow] = await store
      .set(writeDb$)
      .select({ versionId: agentRuns.agentComposeVersionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, codexRunId));
    if (!codexRunRow || !codexRunRow.versionId) {
      throw new Error("expected codex run with version");
    }
    await store
      .set(writeDb$)
      .update(agentComposeVersions)
      .set({ content: { agent: { framework: "codex" } } })
      .where(eq(agentComposeVersions.id, codexRunRow.versionId));
    mocks.clerk.session(codexFixture.userId, codexFixture.orgId);

    // When + Then: 200 — the framework is read from the
    // legacy compose content.
    const codex = await accept(
      c.getAgentEvents({
        params: { id: codexRunId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(codex.body).toStrictEqual({
      events: [],
      hasMore: false,
      framework: "codex",
    });

    // Given: a valid session with no run.
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 — an unknown id.
    const unknown = await accept(
      c.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: a run owned by another user.
    const ownerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const ownerCompose = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const { runId: ownerRunId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: ownerCompose.composeId,
        status: "running",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 — a different user gets no
    // existence leak.
    const crossUser = await accept(
      c.getAgentEvents({
        params: { id: ownerRunId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: a run with `lastEventSequence: 1` and a
    // visibility poll that returns the contiguous prefix.
    const watermarkFx = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const watermarkCompose = await store.set(
      seedCompose$,
      { orgId: watermarkFx.orgId, userId: watermarkFx.userId },
      context.signal,
    );
    const { runId: watermarkRunId } = await store.set(
      seedRun$,
      {
        orgId: watermarkFx.orgId,
        userId: watermarkFx.userId,
        composeId: watermarkCompose.composeId,
        status: "completed",
        lastEventSequence: 1,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query
      .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    mocks.clerk.session(watermarkFx.userId, watermarkFx.orgId);

    // When + Then: 200 — the route polls the watermark +
    // passes `noCache: true` on both calls.
    const watermark = await accept(
      c.getAgentEvents({
        params: { id: watermarkRunId },
        query: { limit: 10, order: "desc" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(watermark.body.events).toStrictEqual([]);
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(2);
    const calls = context.mocks.axiom.query.mock.calls;
    expect(calls[0]?.[0]).toContain("project sequenceNumber");
    expect(calls[0]?.[1]).toStrictEqual({ noCache: true });
    expect(calls[1]?.[0]).toContain(`runId == "${watermarkRunId}"`);
    expect(calls[1]?.[1]).toStrictEqual({ noCache: true });

    // Given: a run with `lastEventSequence: 3` and
    // `since: 10` (desc) → since >= last → target = null.
    const skipFx = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const skipCompose = await store.set(
      seedCompose$,
      { orgId: skipFx.orgId, userId: skipFx.userId },
      context.signal,
    );
    const { runId: skipRunId } = await store.set(
      seedRun$,
      {
        orgId: skipFx.orgId,
        userId: skipFx.userId,
        composeId: skipCompose.composeId,
        status: "completed",
        lastEventSequence: 3,
      },
      context.signal,
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValue([]);
    mocks.clerk.session(skipFx.userId, skipFx.orgId);

    // When + Then: 200 — only the events query (no
    // visibility poll) and no `noCache` option.
    await accept(
      c.getAgentEvents({
        params: { id: skipRunId },
        query: { limit: 10, order: "desc", since: 10 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(1);
    const [apl, opts] = context.mocks.axiom.query.mock.calls[0] ?? [];
    expect(apl).toContain(`runId == "${skipRunId}"`);
    expect(opts).toBeUndefined();

    // Given: a sandbox token with `file:read` but not
    // `agent-run:read`.
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403.
    const sandbox = await accept(
      c.getAgentEvents({
        params: { id: randomUUID() },
        query: { limit: 10, order: "desc" },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandbox.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });
  });
});
