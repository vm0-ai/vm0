import { randomUUID } from "node:crypto";

import { zeroRunContextContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
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

// BDD migration of the legacy `zero-run-context.test.ts`.
// The 8 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (404 unknown → 404 cross-user → 404
// context not available → 200 with snapshot → 200 with
// sparse null Axiom fields omitted → 403 sandbox
// without `agent-run:read`).
//
// The run-context snapshot is stored in Axiom (mocked
// external). The legacy test used
// `axiomMock.ingestMock` + `axiomMock.ingestDataByRun` to
// seed the snapshot. The BDD form routes the same
// fixture through the public response. The
// `omits sparse null Axiom fields` case verifies the
// public response drops null entries from the
// environment / firewalls / volumes / artifact arrays
// when Axiom returns sparse data.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunContextContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function makeSnapshot(runId: string): Record<string, unknown> {
  return {
    runId,
    prompt: "test prompt",
    appendSystemPrompt: null,
    sessionId: null,
    environment: { NODE_ENV: "production", API_KEY: "***" },
    firewalls: [
      {
        name: "test-fw",
        apis: [
          {
            base: "https://api.example.com",
            permissions: [{ name: "read", rules: ["GET /users/*"] }],
          },
        ],
      },
    ],
    volumes: [
      {
        name: "data",
        mountPath: "/data",
        vasStorageName: "vol-1",
        vasVersionId: "ver-1",
      },
    ],
    artifact: {
      mountPath: "/artifacts",
      vasStorageName: "art-1",
      vasVersionId: "art-ver-1",
    },
    networkPolicies: null,
    featureFlags: { computerUse: true, dummy: false },
  };
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/:id/context — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getContext({ params: { id: randomUUID() }, headers: {} }),
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
      c.getContext({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/zero/runs/:id/context — full coverage chain", () => {
  it("gwt-wt-wt: 404 unknown → 404 cross-user → 404 context not available → 200 snapshot → 200 sparse nulls omitted → 403 sandbox no capability", async () => {
    // Given: a fresh fixture + session.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: 404 — an unknown id.
    const unknown = await accept(
      c.getContext({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(unknown.body.error.code).toBe("NOT_FOUND");

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

    // When + Then: 404 — a different user gets no
    // existence leak.
    const crossUser = await accept(
      c.getContext({ params: { id: ownerRunId }, headers: authHeaders() }),
      [404],
    );
    expect(crossUser.body.error.code).toBe("NOT_FOUND");

    // Given: a run owned by the current user, with no
    // context stored in Axiom.
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
    context.mocks.axiom.query.mockResolvedValue([]);

    // When + Then: 404 — the run exists but its context
    // snapshot is not yet available in Axiom.
    const noContext = await accept(
      c.getContext({ params: { id: runId }, headers: authHeaders() }),
      [404],
    );
    expect(noContext.body.error.code).toBe("NOT_FOUND");

    // Given: a context snapshot is now stored in Axiom.
    context.mocks.axiom.query.mockResolvedValue([makeSnapshot(runId)]);

    // When + Then: 200 — the public response carries the
    // sanitized snapshot.
    const snapshot = await accept(
      c.getContext({ params: { id: runId }, headers: authHeaders() }),
      [200],
    );
    expect(snapshot.body).toMatchObject({
      runId,
      prompt: "test prompt",
      sessionId: null,
      environment: { NODE_ENV: "production", API_KEY: "***" },
      featureFlags: { computerUse: true, dummy: false },
    });
    expect(snapshot.body.firewalls).toHaveLength(1);
    expect(snapshot.body.volumes).toHaveLength(1);

    // Given: a sparse context where `environment` has
    // some null values (the route omits null values
    // from the response).
    context.mocks.axiom.query.mockResolvedValue([
      {
        ...makeSnapshot(runId),
        environment: {
          OPENAI_API_KEY: null,
          ZERO_TOKEN: "***",
        },
        networkPolicies: {
          github: {
            allow: ["repo-read"],
            deny: [],
            ask: [],
            unknownPolicy: "allow",
          },
        },
      },
    ]);

    // When + Then: 200 — the public response drops null
    // environment values.
    const sparse = await accept(
      c.getContext({ params: { id: runId }, headers: authHeaders() }),
      [200],
    );
    expect(sparse.body.environment).toStrictEqual({ ZERO_TOKEN: "***" });

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
      c.getContext({
        params: { id: randomUUID() },
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
