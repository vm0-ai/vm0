import { randomUUID } from "node:crypto";

import { zeroConnectorPermissionDenyContract } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const runsApi = createRunsAutomationsApi(context);
const store = createStore();

interface DiagnosticBody {
  readonly method: string;
  readonly url: string;
}

interface ConnectedFixture {
  readonly actor: ApiTestUser;
  readonly type: "reap";
}

const trackConnectedFixture = createFixtureTracker<ConnectedFixture>(
  async (fixture) => {
    await connectorsApi.deleteConnectorByType(fixture.actor, fixture.type);
  },
);
const trackOrgMembershipFixture = createFixtureTracker<OrgMembershipFixture>(
  async (fixture) => {
    await store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

function client() {
  return setupApp({ context })(zeroConnectorPermissionDenyContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return actor.orgId;
}

async function diagnoseWithSession(
  actor: ApiTestUser,
  connectorRef: string,
  body: DiagnosticBody,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    client().diagnose({
      params: { connectorRef },
      headers: { authorization: "Bearer clerk-session" },
      body,
    }),
    [200],
  );
}

async function diagnoseWithToken(
  token: string,
  connectorRef: string,
  body: DiagnosticBody,
) {
  return await accept(
    client().diagnose({
      params: { connectorRef },
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    [200],
  );
}

async function issueDevicePat(actor: ApiTestUser): Promise<string> {
  const started = await authDevice.startCliDevice();
  const approved = await authDevice.requestCliApproval(
    actor,
    { device_code: started.device_code },
    [200],
  );
  expect(approved.body).toStrictEqual({ success: true });

  const token = await authDevice.requestCliToken(started.device_code, [200]);
  if (token.status !== 200) {
    throw new Error(`Expected CLI token exchange, got ${token.status}`);
  }
  return token.body.access_token;
}

async function seedZeroMembership(actor: ApiTestUser): Promise<void> {
  await trackOrgMembershipFixture(
    store.set(
      seedOrgMembership$,
      {
        orgId: requireOrgId(actor),
        userId: actor.userId,
        role: "admin",
      },
      context.signal,
    ),
  );
}

function zeroToken(
  actor: ApiTestUser,
  runId: string,
  capabilities: readonly string[],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: actor.userId,
    orgId: requireOrgId(actor),
    runId,
    capabilities,
    iat: seconds,
    exp: seconds + 600,
  });
}

async function connectReap(
  actor: ApiTestUser,
  apiBaseUrl: string,
): Promise<void> {
  await connectorsApi.connectManualGrant(actor, "reap", "api-token", {
    apiKey: "reap-test-api-key",
    apiBaseUrl,
  });
  await trackConnectedFixture(Promise.resolve({ actor, type: "reap" }));
}

async function createOwnedRun(actor: ApiTestUser): Promise<string> {
  bdd.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  runsApi.configureRunnerGroup();
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `Permission diagnostics ${randomUUID()}`,
    visibility: "private",
  });
  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Create a permission diagnostic fixture",
    modelProvider: "anthropic-api-key",
  });
  return run.runId;
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.axiom.query.mockResolvedValue([]);
});

describe("POST /api/zero/connectors/:connectorRef/diagnostics/permission-deny", () => {
  it("requires organization auth and the connector:read Zero capability", async () => {
    const unauthenticated = await accept(
      client().diagnose({
        params: { connectorRef: "slack" },
        headers: {},
        body: {
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
        },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const withoutOrganization = await accept(
      client().diagnose({
        params: { connectorRef: "slack" },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
        },
      }),
      [401],
    );
    expect(withoutOrganization.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    await seedZeroMembership(actor);
    const runId = `run_${randomUUID()}`;
    const forbidden = await accept(
      client().diagnose({
        params: { connectorRef: "slack" },
        headers: {
          authorization: `Bearer ${zeroToken(actor, runId, [])}`,
        },
        body: {
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
        },
      }),
      [403],
    );
    expect(forbidden.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: connector:read",
    });

    const allowed = await diagnoseWithToken(
      zeroToken(actor, runId, ["connector:read"]),
      "slack",
      {
        method: "POST",
        url: "https://slack.com/api/chat.postMessage",
      },
    );
    expect(allowed.body).toStrictEqual({
      outcome: "matched",
      label: "Slack",
      base: "https://slack.com/api",
      relativePath: "/chat.postMessage",
      permissions: ["chat:write"],
    });
  });

  it("accepts a real CLI personal access token", async () => {
    const actor = bdd.user();
    const token = await issueDevicePat(actor);

    const response = await diagnoseWithToken(token, "slack", {
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
    });

    expect(response.body).toMatchObject({
      outcome: "matched",
      permissions: ["chat:write"],
    });
  });

  it("rejects malformed bodies at the contract boundary", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const response = await createApp({ signal: context.signal }).request(
      "/api/zero/connectors/slack/diagnostics/permission-deny",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
          unexpected: true,
        }),
      },
    );

    expect(response.status).toBe(400);

    const invalidRef = await createApp({
      signal: context.signal,
    }).request("/api/zero/connectors/invalid_ref/diagnostics/permission-deny", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "POST",
        url: "https://slack.com/api/chat.postMessage",
      }),
    });
    expect(invalidRef.status).toBe(400);
  });

  it("returns closed semantic outcomes for unsafe methods, URLs, and paths", async () => {
    const actor = bdd.user();
    const invalidUrls = [
      "slack.com/api/chat.postMessage",
      "https://user@example.com/path",
      "https://api%2eexample.com/path",
      "https://例子.example/path",
      String.raw`https://example.com\path`,
      "https://example.com/has whitespace",
    ];

    const invalidMethod = await diagnoseWithSession(actor, "slack", {
      method: "TRACE",
      url: "https://slack.com/api/chat.postMessage",
    });
    expect(invalidMethod.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "invalid-method",
    });

    for (const url of invalidUrls) {
      const invalidUrl = await diagnoseWithSession(actor, "slack", {
        method: "GET",
        url,
      });
      expect(invalidUrl.body).toStrictEqual({
        outcome: "unsafe-input",
        reason: "invalid-url",
      });
    }

    const unsafePath = await diagnoseWithSession(actor, "slack", {
      method: "GET",
      url: "https://slack.com/api/%2e%2e/admin",
    });
    expect(unsafePath.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "unsafe-path",
    });
  });

  it("distinguishes unknown connectors, bases, and endpoints", async () => {
    const actor = bdd.user();

    const unknownConnector = await diagnoseWithSession(
      actor,
      "missing-connector",
      { method: "GET", url: "https://example.com/path" },
    );
    expect(unknownConnector.body).toStrictEqual({
      outcome: "unknown-connector",
    });

    const noMatchingBase = await diagnoseWithSession(actor, "slack", {
      method: "GET",
      url: "https://example.com/api/not.real",
    });
    expect(noMatchingBase.body).toStrictEqual({
      outcome: "no-matching-base",
      label: "Slack",
    });

    const unknownEndpoint = await diagnoseWithSession(actor, "slack", {
      method: "GET",
      url: "https://slack.com/api/not.real",
    });
    expect(unknownEndpoint.body).toStrictEqual({
      outcome: "unknown-endpoint",
      label: "Slack",
      base: "https://slack.com/api",
      relativePath: "/not.real",
    });
  });

  it("uses the most specific base and never echoes query or fragment data", async () => {
    const actor = bdd.user();
    const response = await diagnoseWithSession(actor, "youtube", {
      method: "PUT",
      url: "https://youtube.googleapis.com/upload/youtube/v3/videos?token=query-sentinel#fragment-sentinel",
    });

    expect(response.body).toStrictEqual({
      outcome: "matched",
      label: "YouTube",
      base: "https://youtube.googleapis.com/upload/youtube",
      relativePath: "/v3/videos",
      permissions: ["videos.create"],
    });
    expect(JSON.stringify(response.body)).not.toContain("query-sentinel");
    expect(JSON.stringify(response.body)).not.toContain("fragment-sentinel");
  });

  it("matches structural dynamic bases without persisted connector state", async () => {
    const actor = bdd.user();

    const quickBooks = await diagnoseWithSession(actor, "quickbooks", {
      method: "GET",
      url: "https://quickbooks.api.intuit.com/v3/company/realm-123/query",
    });
    expect(quickBooks.body).toStrictEqual({
      outcome: "matched",
      label: "QuickBooks",
      base: `https://quickbooks.api.intuit.com/v3/company/\${{ vars.QUICKBOOKS_REALM_ID }}`,
      relativePath: "/query",
      permissions: ["query"],
    });

    const internalConnector = await diagnoseWithSession(actor, "test-oauth", {
      method: "GET",
      url: "https://tenant.preview.vm6.ai/api/test/oauth-provider/echo",
    });
    expect(internalConnector.body).toStrictEqual({
      outcome: "matched",
      label: "Test OAuth (internal)",
      base: `https://\${{ vars.TEST_OAUTH_TENANT_ID }}.{pr}.vm6.ai/api/test/oauth-provider`,
      relativePath: "/echo",
      permissions: ["echo"],
    });
  });

  it("resolves opaque bases from the selected connector and isolates user and organization state", async () => {
    const owner = bdd.user();
    const orgId = requireOrgId(owner);
    const sameOrgOtherUser = bdd.user({ orgId });
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const storedBase = "https://sandbox.api.reap.global/v1";

    const unresolved = await diagnoseWithSession(owner, "reap", {
      method: "GET",
      url: `${storedBase}/users`,
    });
    expect(unresolved.body).toStrictEqual({
      outcome: "unresolved-dynamic-base",
      label: "Reap",
    });

    await connectReap(owner, storedBase);

    const matched = await diagnoseWithSession(owner, "reap", {
      method: "GET",
      url: `${storedBase}/users`,
    });
    expect(matched.body).toStrictEqual({
      outcome: "matched",
      label: "Reap",
      base: storedBase,
      relativePath: "/users",
      permissions: ["read"],
    });

    const otherBase = await diagnoseWithSession(owner, "reap", {
      method: "GET",
      url: "https://prod.api.reap.global/v1/users",
    });
    expect(otherBase.body).toStrictEqual({
      outcome: "no-matching-base",
      label: "Reap",
    });

    for (const actor of [sameOrgOtherUser, sameUserOtherOrg]) {
      const isolated = await diagnoseWithSession(actor, "reap", {
        method: "GET",
        url: `${storedBase}/users`,
      });
      expect(isolated.body).toStrictEqual({
        outcome: "unresolved-dynamic-base",
        label: "Reap",
      });
    }
  });

  it("merges routes from exact duplicate catalog bases", async () => {
    const actor = bdd.user();
    const response = await diagnoseWithSession(actor, "cloudflare", {
      method: "POST",
      url: "https://api.cloudflare.com/client/v4/pages/assets/check-missing",
    });

    expect(response.body).toStrictEqual({
      outcome: "matched",
      label: "Cloudflare",
      base: "https://api.cloudflare.com/client",
      relativePath: "/v4/pages/assets/check-missing",
      permissions: ["page.write"],
    });
  });

  it("uses only the owned run snapshot for Zero calls and never falls back to stored state", async () => {
    const actor = bdd.user();
    const storedBase = "https://sandbox.api.reap.global/v1";
    const runBase = "https://prod.api.reap.global/v1";
    await connectReap(actor, storedBase);
    const runId = await createOwnedRun(actor);
    await seedZeroMembership(actor);
    const token = zeroToken(actor, runId, ["connector:read"]);

    context.mocks.axiom.query.mockResolvedValue([
      {
        runId,
        firewalls: [
          {
            kind: "builtin",
            name: "reap",
            baseUrlVars: { REAP_API_BASE_URL: runBase },
          },
        ],
      },
    ]);

    const runMatch = await diagnoseWithToken(token, "reap", {
      method: "GET",
      url: `${runBase}/users`,
    });
    expect(runMatch.body).toStrictEqual({
      outcome: "matched",
      label: "Reap",
      base: runBase,
      relativePath: "/users",
      permissions: ["read"],
    });

    const storedStateIgnored = await diagnoseWithToken(token, "reap", {
      method: "GET",
      url: `${storedBase}/users`,
    });
    expect(storedStateIgnored.body).toStrictEqual({
      outcome: "no-matching-base",
      label: "Reap",
    });

    const sameOrgOtherUser = bdd.user({ orgId: requireOrgId(actor) });
    const sameUserOtherOrg = bdd.user({ userId: actor.userId });
    for (const intruder of [sameOrgOtherUser, sameUserOtherOrg]) {
      await seedZeroMembership(intruder);
      const isolated = await diagnoseWithToken(
        zeroToken(intruder, runId, ["connector:read"]),
        "reap",
        { method: "GET", url: `${runBase}/users` },
      );
      expect(isolated.body).toStrictEqual({
        outcome: "unresolved-dynamic-base",
        label: "Reap",
      });
    }

    context.mocks.axiom.query.mockResolvedValue([]);
    const missingSnapshot = await diagnoseWithToken(token, "reap", {
      method: "GET",
      url: `${storedBase}/users`,
    });
    expect(missingSnapshot.body).toStrictEqual({
      outcome: "unresolved-dynamic-base",
      label: "Reap",
    });
  });
});
