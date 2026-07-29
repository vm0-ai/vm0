import { randomUUID } from "node:crypto";

import {
  type ConnectorCheckRequest,
  zeroConnectorCheckContract,
} from "@vm0/api-contracts/contracts/zero-connector-check";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  seedConnectorStorageRow,
  setConnectorCredentialStorageState,
  setConnectorVariableOwner,
} from "./helpers/connector-credential-storage-state";
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
const runsApi = createRunsApi(context);
const store = createStore();

interface ConnectedFixture {
  readonly actor: ApiTestUser;
  readonly type: "github" | "reap";
}

const trackConnectedFixture = createFixtureTracker<ConnectedFixture>(
  async (fixture) => {
    await connectorsApi.deleteConnectorBySlug(fixture.actor, fixture.type);
  },
);
const trackOrgMembershipFixture = createFixtureTracker<OrgMembershipFixture>(
  async (fixture) => {
    await store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

function client() {
  return setupApp({ context })(zeroConnectorCheckContract);
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

async function checkWithSession(
  actor: ApiTestUser,
  body: ConnectorCheckRequest,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    client().check({
      headers: { authorization: "Bearer clerk-session" },
      body,
    }),
    [200],
  );
}

async function checkWithToken(token: string, body: ConnectorCheckRequest) {
  return await accept(
    client().check({
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
): Promise<string> {
  const connector = await connectorsApi.connectManualGrant(
    actor,
    "reap",
    "api-token",
    {
      apiKey: "reap-test-api-key",
      apiBaseUrl,
    },
  );
  await trackConnectedFixture(Promise.resolve({ actor, type: "reap" }));
  return connector.id;
}

async function createOwnedRun(actor: ApiTestUser): Promise<string> {
  bdd.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  runsApi.configureRunnerGroup();
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `Connector check ${randomUUID()}`,
    visibility: "private",
  });
  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Create a connector check fixture",
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

describe("POST /api/zero/connectors/diagnostics/check", () => {
  it("requires organization auth and both Zero capabilities", async () => {
    const body = {
      mode: "url" as const,
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
    };
    const unauthenticated = await accept(
      client().check({ headers: {}, body }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const withoutOrganization = await accept(
      client().check({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [401],
    );
    expect(withoutOrganization.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    await seedZeroMembership(actor);
    const runId = await createOwnedRun(actor);
    const withoutConnectorRead = await accept(
      client().check({
        headers: {
          authorization: `Bearer ${zeroToken(actor, runId, ["agent-run:read"])}`,
        },
        body,
      }),
      [403],
    );
    expect(withoutConnectorRead.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: connector:read",
    });

    const withoutRunRead = await accept(
      client().check({
        headers: {
          authorization: `Bearer ${zeroToken(actor, runId, ["connector:read"])}`,
        },
        body,
      }),
      [403],
    );
    expect(withoutRunRead.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: agent-run:read",
    });

    context.mocks.axiom.query.mockResolvedValue([
      {
        runId,
        firewalls: [{ kind: "builtin", name: "slack" }],
        networkPolicyEntries: [
          {
            name: "slack",
            policy: {
              allow: [],
              deny: ["chat:write"],
              ask: [],
              unknownPolicy: "ask",
            },
          },
        ],
      },
    ]);
    const allowed = await checkWithToken(
      zeroToken(actor, runId, ["connector:read", "agent-run:read"]),
      body,
    );
    expect(allowed.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: { connectorRef: "slack", label: "Slack" },
      run: { status: "configured" },
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "chat:write",
            policy: { outcome: "deny", basis: "deny-list" },
          },
        ],
      },
    });
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(1);
  });

  it("enforces strict bodies and returns sanitized unsafe-input outcomes", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const malformed = await createApp({ signal: context.signal }).request(
      "/api/zero/connectors/diagnostics/check",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: "url",
          method: "GET",
          url: "https://api.github.com/repos/vm0-ai/vm0",
          unexpected: true,
        }),
      },
    );
    expect(malformed.status).toBe(400);

    const invalidMethod = await checkWithSession(actor, {
      mode: "url",
      method: "TRACE",
      url: "https://api.github.com/repos/vm0-ai/vm0",
    });
    expect(invalidMethod.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "invalid-method",
    });

    for (const url of [
      "api.github.com/repos/vm0-ai/vm0",
      "https://user@example.com/path",
      "https://api%2eexample.com/path",
      "https://例子.example/path",
      String.raw`https://example.com\path`,
      "https://example.com/has whitespace",
    ]) {
      const invalidUrl = await checkWithSession(actor, {
        mode: "url",
        method: "GET",
        url,
      });
      expect(invalidUrl.body).toStrictEqual({
        outcome: "unsafe-input",
        reason: "invalid-url",
      });
    }

    const unsafePath = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/%2e%2e/private",
    });
    expect(unsafePath.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "unsafe-path",
    });
  });

  it("supports a real PAT and resolves hidden server-authored metadata without private refs", async () => {
    const actor = bdd.user();
    const token = await issueDevicePat(actor);
    const slack = await checkWithToken(token, {
      mode: "url",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage?query-sentinel=secret#fragment-sentinel",
    });
    expect(slack.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: {
        connectorRef: "slack",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      run: { status: "not-scoped" },
      method: "POST",
      base: "https://slack.com/api",
      relativePath: "/chat.postMessage",
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "chat:write",
            policy: {
              outcome: "unavailable",
              basis: "not-run-scoped",
            },
          },
        ],
      },
    });
    const serializedSlack = JSON.stringify(slack.body);
    expect(serializedSlack).not.toContain("query-sentinel");
    expect(serializedSlack).not.toContain("fragment-sentinel");

    const hidden = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "https://tenant.preview.vm6.ai/api/test/oauth-provider/echo",
      connectorRef: "test-oauth",
    });
    expect(hidden.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorRef: "test-oauth",
        label: "Test OAuth",
        visibility: "unavailable",
      },
      relativePath: "/echo",
    });
    expect(JSON.stringify(hidden.body)).not.toContain("vars.");
    expect(JSON.stringify(hidden.body)).not.toContain("TEST_OAUTH_TENANT_ID");
  });

  it("resolves environment aliases, ambiguity, and URL selectors deterministically", async () => {
    const actor = bdd.user();
    const knownEnvironment = await checkWithSession(actor, {
      mode: "environment",
      environmentName: "GH_TOKEN",
      permission: "contents:read",
    });
    expect(knownEnvironment.body).toStrictEqual({
      outcome: "resolved",
      mode: "environment",
      connector: {
        connectorRef: "github",
        label: "GitHub",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      environmentName: "GH_TOKEN",
      run: { status: "not-scoped" },
      permission: { outcome: "unavailable", basis: "not-run-scoped" },
    });
    const siblingAlias = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      environmentName: "GH_TOKEN",
    });
    expect(siblingAlias.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "github" },
      environmentNames: ["GH_TOKEN"],
    });
    const unknownEnvironment = await checkWithSession(actor, {
      mode: "environment",
      environmentName: "UNKNOWN_CONNECTOR_VALUE",
    });
    expect(unknownEnvironment.body).toStrictEqual({
      outcome: "unknown-environment",
    });

    const nintendoUrl = "https://api.accounts.nintendo.com/2.0.0/users/me";
    const ambiguous = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
    });
    expect(ambiguous.body).toStrictEqual({
      outcome: "ambiguous",
      candidates: [
        { connectorRef: "nintendo-store", label: "Nintendo Store" },
        {
          connectorRef: "nintendo-switch-parental-controls",
          label: "Nintendo Switch Parental Controls",
        },
      ],
    });

    const selected = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
      connectorRef: "nintendo-switch-parental-controls",
    });
    expect(selected.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorRef: "nintendo-switch-parental-controls",
      },
      environmentNames: ["NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN"],
    });

    const mismatch = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      connectorRef: "slack",
    });
    expect(mismatch.body).toMatchObject({
      outcome: "connector-mismatch",
      connector: { connectorRef: "github" },
    });

    const notOwned = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      environmentName: "SLACK_TOKEN",
    });
    expect(notOwned.body).toMatchObject({
      outcome: "environment-not-owned",
      connector: { connectorRef: "github" },
    });

    const notUsed = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
      connectorRef: "nintendo-switch-parental-controls",
      environmentName: "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
    });
    expect(notUsed.body).toStrictEqual({
      outcome: "environment-not-used",
      connector: {
        connectorRef: "nintendo-switch-parental-controls",
        label: "Nintendo Switch Parental Controls",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      environmentNames: ["NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN"],
    });

    const unknownConnector = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://example.com/path",
      connectorRef: "missing-connector",
    });
    expect(unknownConnector.body).toStrictEqual({
      outcome: "unknown-connector",
    });

    const segmentBoundary = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com.evil.example/repos/vm0-ai/vm0",
    });
    expect(segmentBoundary.body).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });
  });

  it("uses one isolated stored-state snapshot for opaque dynamic bases", async () => {
    const owner = bdd.user();
    const orgId = requireOrgId(owner);
    const sameOrgOtherUser = bdd.user({ orgId });
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const storedBase = "https://sandbox.api.reap.global/v1";
    const request = {
      mode: "url" as const,
      method: "GET",
      url: `${storedBase}/users`,
      connectorRef: "reap",
    };

    const unresolved = await checkWithSession(owner, request);
    expect(unresolved.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorRef: "reap" },
    });

    const reapConnectorId = await connectReap(owner, storedBase);
    const resolved = await checkWithSession(owner, request);
    expect(resolved.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "reap" },
      base: storedBase,
      relativePath: "/users",
      run: { status: "not-scoped" },
    });
    const serialized = JSON.stringify(resolved.body);
    expect(serialized).not.toContain("REAP_API_BASE_URL");
    expect(serialized).not.toContain("reap-test-api-key");

    await setConnectorCredentialStorageState(context, {
      connectorSlug: "reap",
      orgId,
      storageVersion: 2,
      userId: owner.userId,
    });
    const incompatible = await checkWithSession(owner, request);
    expect(incompatible.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorRef: "reap" },
    });
    await setConnectorCredentialStorageState(context, {
      connectorSlug: "reap",
      orgId,
      storageVersion: 1,
      userId: owner.userId,
    });
    await expect(checkWithSession(owner, request)).resolves.toMatchObject({
      body: { outcome: "resolved", base: storedBase },
    });

    const foreignConnectorId = await seedConnectorStorageRow(context, {
      authMethod: "oauth",
      connectorSlug: "github",
      orgId,
      storageVersion: 1,
      userId: owner.userId,
    });
    await trackConnectedFixture(
      Promise.resolve({ actor: owner, type: "github" }),
    );
    await setConnectorVariableOwner(context, {
      connectorId: foreignConnectorId,
      name: "REAP_API_BASE_URL",
      orgId,
      userId: owner.userId,
    });
    const wrongOwner = await checkWithSession(owner, request);
    expect(wrongOwner.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorRef: "reap" },
    });
    await setConnectorVariableOwner(context, {
      connectorId: reapConnectorId,
      name: "REAP_API_BASE_URL",
      orgId,
      userId: owner.userId,
    });
    await expect(checkWithSession(owner, request)).resolves.toMatchObject({
      body: { outcome: "resolved", base: storedBase },
    });

    for (const actor of [sameOrgOtherUser, sameUserOtherOrg]) {
      const isolated = await checkWithSession(actor, request);
      expect(isolated.body).toMatchObject({
        outcome: "unresolved-dynamic-base",
        connector: { connectorRef: "reap" },
      });
    }
  });

  it("uses only an owned Zero snapshot, including dynamic bases and final policies", async () => {
    const owner = bdd.user();
    const runId = await createOwnedRun(owner);
    await seedZeroMembership(owner);
    const token = zeroToken(owner, runId, ["connector:read", "agent-run:read"]);
    const runBase = "https://prod.api.reap.global/v1";
    const secondRunBase = "https://sandbox.api.reap.global/v1";
    context.mocks.axiom.query.mockResolvedValue([
      {
        runId,
        firewalls: [
          {
            kind: "builtin",
            name: "reap",
            baseUrlVars: { REAP_API_BASE_URL: runBase },
          },
          {
            kind: "builtin",
            name: "reap",
            baseUrlVars: { REAP_API_BASE_URL: secondRunBase },
          },
        ],
        networkPolicyEntries: [
          {
            name: "reap",
            policy: {
              allow: [],
              deny: [],
              ask: ["read"],
              unknownPolicy: "deny",
            },
          },
        ],
      },
    ]);

    const urlResult = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: `${runBase}/users`,
    });
    expect(urlResult.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "reap" },
      run: { status: "configured", bases: [runBase, secondRunBase] },
      base: runBase,
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "read",
            policy: { outcome: "ask", basis: "ask-list" },
          },
        ],
      },
    });

    const environmentResult = await checkWithToken(token, {
      mode: "environment",
      environmentName: "REAP_API_KEY",
      permission: "write",
    });
    expect(environmentResult.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "reap" },
      run: { status: "configured", bases: [runBase, secondRunBase] },
      permission: { outcome: "allow", basis: "not-blocked" },
    });

    const unknownEndpoint = await checkWithToken(token, {
      mode: "url",
      method: "OPTIONS",
      url: `${runBase}/not-a-real-endpoint`,
    });
    expect(unknownEndpoint.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "reap" },
      permission: {
        kind: "unknown-endpoint",
        policy: { outcome: "deny", basis: "unknown-policy" },
      },
    });

    const notConfiguredEnvironment = await checkWithToken(token, {
      mode: "environment",
      environmentName: "GH_TOKEN",
      permission: "contents:read",
    });
    expect(notConfiguredEnvironment.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "github" },
      run: { status: "not-configured" },
      permission: {
        outcome: "unavailable",
        basis: "connector-not-configured",
      },
    });

    const globalFallbackDenied = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
    });
    expect(globalFallbackDenied.body).toStrictEqual({
      outcome: "no-match",
      scope: "run",
    });

    context.mocks.axiom.query.mockResolvedValue([
      {
        runId,
        firewalls: [
          {
            kind: "builtin",
            name: "reap",
            baseUrlVars: { REAP_API_BASE_URL: "http://127.0.0.1" },
          },
        ],
      },
    ]);
    const rejectedDynamicBase = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "http://127.0.0.1/users",
      connectorRef: "reap",
    });
    expect(rejectedDynamicBase.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorRef: "reap" },
    });

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
    const unavailablePolicies = await checkWithToken(token, {
      mode: "environment",
      environmentName: "REAP_API_KEY",
      permission: "read",
    });
    expect(unavailablePolicies.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "reap" },
      run: { status: "configured", bases: [runBase] },
      permission: {
        outcome: "unavailable",
        basis: "policies-unavailable",
      },
    });

    context.mocks.axiom.query.mockResolvedValue([]);
    const missingSnapshot = await checkWithToken(token, {
      mode: "environment",
      environmentName: "REAP_API_KEY",
    });
    expect(missingSnapshot.body).toStrictEqual({
      outcome: "run-context-unavailable",
    });

    const intruder = bdd.user({ orgId: requireOrgId(owner) });
    await seedZeroMembership(intruder);
    const wrongOwner = await accept(
      client().check({
        headers: {
          authorization: `Bearer ${zeroToken(intruder, runId, [
            "connector:read",
            "agent-run:read",
          ])}`,
        },
        body: {
          mode: "environment",
          environmentName: "REAP_API_KEY",
        },
      }),
      [404],
    );
    expect(wrongOwner.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: "Agent run not found",
    });
  });

  it("diagnoses sanitized inline entries without exposing their source snapshot", async () => {
    const actor = bdd.user();
    const runId = await createOwnedRun(actor);
    await seedZeroMembership(actor);
    const token = zeroToken(actor, runId, ["connector:read", "agent-run:read"]);
    const inlineBase = "https://legacy-github.example.com";
    context.mocks.axiom.query.mockResolvedValue([
      {
        runId,
        firewalls: [
          {
            name: "github",
            apis: [
              {
                base: inlineBase,
                permissions: [
                  {
                    name: "repository.read",
                    rules: ["GET /repos/{owner}/{repo}"],
                  },
                ],
              },
            ],
          },
          {
            name: "github",
            apis: [
              {
                base: inlineBase,
                permissions: [
                  {
                    name: "issues.write",
                    rules: ["POST /repos/{owner}/{repo}/issues"],
                  },
                ],
              },
            ],
          },
          {
            name: "github",
            apis: [
              {
                base: "https://api.github.com",
                permissions: [
                  {
                    name: "repository.read",
                    rules: ["GET /repos/{owner}/{repo}"],
                  },
                ],
              },
            ],
          },
          { kind: "builtin", name: "unknown-non-connector" },
        ],
        networkPolicyEntries: [
          {
            name: "github",
            policy: {
              allow: ["repository.read"],
              deny: [],
              ask: ["issues.write"],
              unknownPolicy: "deny",
            },
          },
        ],
      },
    ]);

    const result = await checkWithToken(token, {
      mode: "url",
      method: "POST",
      url: `${inlineBase}/repos/vm0-ai/vm0/issues?query-private=1#fragment-private`,
      connectorRef: "github",
    });
    expect(result.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "github" },
      environmentNames: null,
      run: {
        status: "configured",
        bases: ["https://api.github.com", inlineBase],
      },
      relativePath: "/repos/vm0-ai/vm0/issues",
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "issues.write",
            policy: { outcome: "ask", basis: "ask-list" },
          },
        ],
      },
    });
    const serialized = JSON.stringify(result.body);
    for (const forbidden of [
      "query-private",
      "fragment-private",
      "runId",
      "networkPolicies",
      '"allow":',
      '"deny":',
      '"ask":',
      "repository.read",
      "unknown-non-connector",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const recoveredEnvironment = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      connectorRef: "github",
    });
    expect(recoveredEnvironment.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "github" },
      environmentNames: ["GITHUB_TOKEN"],
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "repository.read",
            policy: { outcome: "allow", basis: "allow-list" },
          },
        ],
      },
    });

    const inlineUnknownEndpoint = await checkWithToken(token, {
      mode: "url",
      method: "OPTIONS",
      url: `${inlineBase}/not-a-real-endpoint`,
      connectorRef: "github",
    });
    expect(inlineUnknownEndpoint.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorRef: "github" },
      permission: {
        kind: "unknown-endpoint",
        policy: { outcome: "deny", basis: "unknown-policy" },
      },
    });
  });
});
