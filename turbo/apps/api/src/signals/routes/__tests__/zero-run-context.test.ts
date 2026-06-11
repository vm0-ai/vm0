import { randomUUID } from "node:crypto";

import { zeroRunContextContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
// Reuse run-seeding helpers from the usage-insight test module — same
// fixture shape, no need to duplicate. Same precedent as PR #12408 / #12414.
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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function makeEntriesSnapshot(runId: string): Record<string, unknown> {
  return {
    runId,
    prompt: "test prompt",
    appendSystemPrompt: null,
    sessionId: null,
    environmentEntries: [
      { name: "NODE_ENV", value: "production" },
      { name: "API_KEY", value: "***" },
    ],
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
    networkPolicyEntries: [
      {
        name: "github",
        policy: {
          allow: ["repo-read"],
          deny: [],
          ask: [],
          unknownPolicy: "allow",
        },
      },
    ],
    featureFlagEntries: [
      { name: "computerUse", enabled: true },
      { name: "dummy", enabled: false },
    ],
  };
}

function makeLegacySnapshot(runId: string): Record<string, unknown> {
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

describe("GET /api/zero/runs/:id/context", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when the run does not exist", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when run belongs to a different user (no existence leak)", async () => {
    const ownerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );

    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when context not available", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Run context not available", code: "NOT_FOUND" },
    });
  });

  it("returns the run context snapshot", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([makeEntriesSnapshot(runId)]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runId).toBe(runId);
    expect(response.body.prompt).toBe("test prompt");
    expect(response.body.sessionId).toBeNull();
    expect(response.body.environment).toStrictEqual({
      NODE_ENV: "production",
      API_KEY: "***",
    });
    expect(response.body.firewalls).toHaveLength(1);
    expect(response.body.firewalls[0]?.name).toBe("test-fw");
    expect(response.body.volumes).toHaveLength(1);
    expect(response.body.artifact).toBeDefined();
    expect(response.body.networkPolicies).toStrictEqual({
      github: {
        allow: ["repo-read"],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      },
    });
    expect(response.body.featureFlags).toStrictEqual({
      computerUse: true,
      dummy: false,
    });
  });

  it("omits malformed collection fields before response validation", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([
      {
        ...makeEntriesSnapshot(runId),
        firewalls: [
          {
            name: "valid-fw",
            apis: [
              {
                base: "https://api.example.com",
                permissions: [
                  {
                    name: "read",
                    description: "Read records",
                    rules: ["GET /records/*"],
                  },
                  { name: "bad-permission", rules: [null] },
                ],
              },
              { base: null, permissions: [] },
            ],
          },
          { name: "bad-fw", apis: null },
        ],
        volumes: [
          {
            name: "data",
            mountPath: "/data",
            vasStorageName: "vol-1",
            vasVersionId: "ver-1",
          },
          {
            name: "broken",
            mountPath: "/broken",
            vasStorageName: null,
            vasVersionId: "ver-broken",
          },
        ],
        artifact: {
          mountPath: "/artifacts",
          vasStorageName: null,
          vasVersionId: "art-ver-1",
        },
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.firewalls).toStrictEqual([
      {
        name: "valid-fw",
        apis: [
          {
            base: "https://api.example.com",
            permissions: [
              {
                name: "read",
                description: "Read records",
                rules: ["GET /records/*"],
              },
            ],
          },
        ],
      },
    ]);
    expect(response.body.volumes).toStrictEqual([
      {
        name: "data",
        mountPath: "/data",
        vasStorageName: "vol-1",
        vasVersionId: "ver-1",
      },
    ]);
    expect(response.body.artifact).toBeNull();
  });

  it("prefers entries over legacy map fields", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([
      {
        ...makeEntriesSnapshot(runId),
        environment: { LEGACY_ENV: "legacy" },
        environmentEntries: [{ name: "ENTRY_ENV", value: "entry" }],
        networkPolicies: {
          legacy: {
            allow: ["legacy-read"],
            deny: [],
            ask: [],
            unknownPolicy: "allow",
          },
        },
        networkPolicyEntries: [
          {
            name: "entry",
            policy: {
              allow: ["entry-read"],
              deny: [],
              ask: [],
              unknownPolicy: "deny",
            },
          },
        ],
        featureFlags: { legacyFlag: true },
        featureFlagEntries: [{ name: "entryFlag", enabled: false }],
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.environment).toStrictEqual({ ENTRY_ENV: "entry" });
    expect(response.body.networkPolicies).toStrictEqual({
      entry: {
        allow: ["entry-read"],
        deny: [],
        ask: [],
        unknownPolicy: "deny",
      },
    });
    expect(response.body.featureFlags).toStrictEqual({ entryFlag: false });
  });

  it("does not fall back to legacy maps when entries are present but invalid", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([
      {
        ...makeEntriesSnapshot(runId),
        environment: { LEGACY_ENV: "legacy" },
        environmentEntries: [{ name: null, value: "invalid" }],
        networkPolicies: {
          legacy: {
            allow: ["legacy-read"],
            deny: [],
            ask: [],
            unknownPolicy: "allow",
          },
        },
        networkPolicyEntries: [
          {
            name: "invalid",
            policy: {
              allow: ["entry-read"],
              deny: [],
              ask: [],
              unknownPolicy: null,
            },
          },
        ],
        featureFlags: { legacyFlag: true },
        featureFlagEntries: [{ name: "invalid", enabled: null }],
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.environment).toStrictEqual({});
    expect(response.body.networkPolicies).toBeNull();
    expect(response.body.featureFlags).toBeNull();
  });

  it("falls back to legacy map fields and omits sparse null values", async () => {
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
    context.mocks.axiom.query.mockResolvedValue([
      {
        ...makeLegacySnapshot(runId),
        environmentEntries: null,
        networkPolicyEntries: null,
        featureFlagEntries: null,
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
          slack: {
            allow: null,
            deny: null,
            ask: null,
            unknownPolicy: null,
          },
        },
        featureFlags: {
          lab: true,
          dummy: null,
        },
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.environment).toStrictEqual({
      ZERO_TOKEN: "***",
    });
    expect(response.body.networkPolicies).toStrictEqual({
      github: {
        allow: ["repo-read"],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      },
    });
    expect(response.body.featureFlags).toStrictEqual({
      lab: true,
    });
  });

  it("returns 403 for a sandbox token without agent-run:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const tokenRunId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: tokenRunId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroRunContextContract);

    const response = await accept(
      client.getContext({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });
  });
});
