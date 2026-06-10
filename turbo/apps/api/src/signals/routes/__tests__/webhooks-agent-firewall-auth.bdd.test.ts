import { randomUUID } from "node:crypto";

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import {
  basicTemplate,
  createFirewallApi,
  secretTemplate,
  varTemplate,
} from "./helpers/api-bdd-firewall";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";

const ORG_SENTINEL_USER_ID = "__org__";

/**
 * HOOK-02 / FW: firewall auth template resolution and connector refresh
 * through POST /api/webhooks/agent/firewall/auth.
 *
 * Given state is constructed through public routes only: the dev-gated
 * /api/cli/auth/test-token route provisions a run-ready org, zero agent and
 * run creation use the normal product APIs, and connector/provider rows come
 * from /api/cli/auth/test-connector and /api/cli/auth/test-codex-oauth.
 *
 * Unreachable through public APIs (kept out of this file deliberately):
 * - Advisory-lock concurrency branches (locked refresh divergence and
 *   mid-request row deletion) need pg locks or row deletes.
 * - TOKEN_ACCESS_RESOLUTION_FAILED needs a current token whose backing secret
 *   row is missing; public seeding writes both atomically.
 * - The 402/5s low-credit billable lease needs a public API that drains an
 *   org's credits below the threshold while keeping the tier active.
 */

const context = testContext();

async function firewallRun(): Promise<{
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly headers: { readonly authorization: string };
}> {
  const bdd = createBddApi(context);
  const runsApi = createRunsSchedulesApi(context);
  const fw = createFirewallApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  runsApi.configureRunnerGroup();
  await fw.provisionRunReadyOrg(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD firewall agent",
    description: "Exercises firewall auth resolution.",
    visibility: "private",
  });
  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve firewall auth",
    modelProvider: "anthropic-api-key",
  });
  return {
    actor,
    runId: run.runId,
    headers: fw.sandboxHeaders(actor, run.runId),
  };
}

describe("FW-1: firewall auth boundaries", () => {
  it("rejects missing, malformed, and runless firewall auth requests", async () => {
    const fw = createFirewallApi(context);
    const bdd = createBddApi(context);
    const outsider = bdd.user();
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {},
    };

    const missingAuth = await fw.requestFirewallAuth({}, body, [401]);
    expectApiError(missingAuth.body);

    const junkToken = await fw.requestFirewallAuth(
      { authorization: "Bearer junk" },
      body,
      [401],
    );
    expectApiError(junkToken.body);

    const headers = fw.sandboxHeaders(outsider, randomUUID());
    const invalidJson = await fw.requestFirewallAuthRaw("not json", headers);
    expect(invalidJson.status).toBe(400);

    const missingFields = await fw.requestFirewallAuthRaw(
      JSON.stringify({ authHeaders: {} }),
      headers,
    );
    expect(missingFields.status).toBe(400);

    const missingRun = await fw.requestFirewallAuth(headers, body, [400]);
    expectApiError(missingRun.body);
    expect(missingRun.body.error.message).toContain("Run not found");
  });

  it("rejects undecryptable secret payloads for a real run", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const garbage = await fw.requestFirewallAuth(
      headers,
      { encryptedSecrets: "garbage", authHeaders: {} },
      [400],
    );
    expectApiError(garbage.body);
    expect(garbage.body.error.message).toContain("Failed to decrypt");
  });
});

describe("FW-2: template resolution without connector refresh", () => {
  it("resolves secret, var, and basic templates across headers, base, and query", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          API_KEY: "secret-value",
          BASIC_USER: "alice",
          BASE_SECRET: "base-secret",
          QUERY_SECRET: "query-secret",
          SHARED: "secret-shared",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
          "X-Tenant": varTemplate("TENANT"),
          "X-Basic": basicTemplate("secrets.BASIC_USER", "vars.BASIC_PASS"),
          "X-Literal-Basic": basicTemplate('"alice"', '"literal-pass"'),
          "X-Shared": `${secretTemplate("SHARED")}:${varTemplate("SHARED")}`,
        },
        authBase: `https://api.example.test/${secretTemplate("BASE_SECRET")}`,
        authQuery: { token: secretTemplate("QUERY_SECRET") },
        vars: {
          TENANT: "tenant-1",
          BASIC_PASS: "var-pass",
          SHARED: "var-shared",
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected firewall auth resolution to succeed");
    }
    expect(resolved.body.headers.Authorization).toBe("Bearer secret-value");
    expect(resolved.body.headers["X-Tenant"]).toBe("tenant-1");
    expect(resolved.body.headers["X-Basic"]).toBe(
      `Basic ${Buffer.from("alice:var-pass").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Literal-Basic"]).toBe(
      `Basic ${Buffer.from("alice:literal-pass").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Shared"]).toBe("secret-shared:var-shared");
    expect(resolved.body.base).toBe("https://api.example.test/base-secret");
    expect(resolved.body.query).toStrictEqual({ token: "query-secret" });
    expect(resolved.body.expiresAt).toBeNull();
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
    expect(resolved.body.refreshedSecrets).toStrictEqual([]);
    expect(resolved.body.resolvedSecrets).toStrictEqual(
      [...resolved.body.resolvedSecrets].sort(),
    );
    expect(resolved.body.resolvedSecrets).toContain("BASE_SECRET");
    expect(resolved.body.resolvedSecrets).toContain("QUERY_SECRET");
  });

  it("reports unresolvable template references as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NEVER_SET")}`,
        },
        secretConnectorMap: {},
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected unresolved secret to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});

describe("FW-3: billable firewall lease", () => {
  it("bounds billable auth expiry by the credit authorization lease", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const before = Math.floor(now() / 1000);
    const leased = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [200],
    );
    if (leased.status !== 200) {
      throw new Error("Expected billable firewall auth to succeed");
    }
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);
  });
});

describe("FW-4: test-oauth connector refresh", () => {
  it("refreshes an expired connector token and serves the stored token afterwards", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "fresh-access-1",
        refreshToken: "refresh-2",
        expiresIn: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
    };

    const before = Math.floor(now() / 1000);
    const refreshed = await fw.requestFirewallAuth(headers, body, [200]);
    if (refreshed.status !== 200) {
      throw new Error("Expected refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe("Bearer fresh-access-1");
    expect(refreshed.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(refreshed.body.refreshedSecrets).toStrictEqual(["TEST_OAUTH_TOKEN"]);
    expect(refreshed.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 3500);
    expect(refreshed.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 3700);

    const served = await fw.requestFirewallAuth(headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected stored-token resolution to succeed");
    }
    expect(served.body.headers.Authorization).toBe("Bearer fresh-access-1");
    expect(served.body.refreshedConnectors).toStrictEqual([]);
  });

  it("defaults the refreshed expiry when the provider omits expires_in", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({ accessToken: "fresh-no-expiry" });
    });

    const before = Math.floor(now() / 1000);
    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe("Bearer fresh-no-expiry");
    expect(refreshed.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 800);
    expect(refreshed.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 1000);
  });

  it("re-runs refresh for a current connector when forceRefresh is set", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "current-access",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "forced-access",
        expiresIn: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "current-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
        forceRefresh: true,
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected forced refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe("Bearer forced-access");
    expect(refreshed.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
  });

  it("resolves a current connector token missing from the runtime namespace", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "db-access",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });

    const synced = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
      },
      [200],
    );
    if (synced.status !== 200) {
      throw new Error("Expected stored-token sync to succeed");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer db-access");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
  });

  it("classifies invalid_grant refresh failures as reconnect-required and recovers", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected invalid_grant to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "recovered-access",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected refresh recovery to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer recovered-access",
    );
  });

  it("classifies provider 500s as upstream failures without marking reconnect", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return new HttpResponse(null, { status: 500 });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected provider 500 to fail with 502");
    }
    expect(failed.body.error.failureReason).toBe("upstream_provider");

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected refresh after outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe("Bearer after-outage");
  });

  it("treats refresh responses without an access token as upstream failures", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json({ ok: true });
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected malformed refresh body to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);
  });
});

describe("FW-6: manual-grant api-token refresh without a provider client", () => {
  it("resolves a missing alias through the synchronous input-driven refresh", async () => {
    const fw = createFirewallApi(context);
    const connectorsApi = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    await connectorsApi.connectManualGrant(actor, "test-oauth", "api-token", {
      TEST_OAUTH_TOKEN: "manual-secret",
      TEST_OAUTH_API_TOKEN_INPUT_VAR: "manual-var",
      TEST_OAUTH_API_TENANT_ID: "tenant-x",
    });

    const before = Math.floor(now() / 1000);
    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_API_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_API_TOKEN: "test-oauth" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected api-token refresh to succeed");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer fresh-test-oauth-api-token:manual-secret:manual-var",
    );
    expect(resolved.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(resolved.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 3500);
  });
});

describe("FW-7: client-unconfigured and mixed-reason refresh failures", () => {
  it("fails without a failure reason when the provider client is unconfigured", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "notion",
      authMethod: "oauth",
      accessToken: "stale-notion",
      refreshToken: "notion-refresh",
      expiresIn: -60,
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          NOTION_TOKEN: "stale-notion",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
        },
        secretConnectorMap: { NOTION_TOKEN: "notion" },
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected unconfigured client refresh to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.connectors).toStrictEqual(["notion"]);
    expect(failed.body.error.failureReason).toBeUndefined();
  });

  it("omits the failure reason when connectors fail for different reasons", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "notion",
      authMethod: "oauth",
      accessToken: "stale-notion",
      refreshToken: "notion-refresh",
      expiresIn: -60,
    });
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          NOTION_TOKEN: "stale-notion",
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          "X-Test": `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        secretConnectorMap: {
          NOTION_TOKEN: "notion",
          TEST_OAUTH_TOKEN: "test-oauth",
        },
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected mixed-reason refresh to fail with 502");
    }
    expect(failed.body.error.connectors?.slice().sort()).toStrictEqual([
      "notion",
      "test-oauth",
    ]);
    expect(failed.body.error.failureReason).toBeUndefined();
  });
});

describe("FW-8: static access tokens and unavailable sources", () => {
  it("requires reconnect for expired static tokens and syncs current ones", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "stale-device",
      expiresIn: -60,
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_DEVICE_TOKEN")}`,
      },
      secretConnectorMap: { TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device" },
    };

    const expired = await fw.requestFirewallAuth(headers, body, [502]);
    if (expired.status !== 502) {
      throw new Error("Expected expired static token to fail with 502");
    }
    expect(expired.body.error.failureReason).toBe("reconnect_required");
    expect(expired.body.error.connectors).toStrictEqual(["test-oauth-device"]);

    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "current-device",
      expiresIn: 3600,
    });
    const synced = await fw.requestFirewallAuth(headers, body, [200]);
    if (synced.status !== 200) {
      throw new Error("Expected current static token to resolve");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer current-device");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
  });

  it("reports aliases for never-connected connector types as not configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
        },
        secretConnectorMap: { NOTION_TOKEN: "notion" },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected unconnected connector alias to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});

describe("FW-9: codex model-provider access", () => {
  it("refreshes an expired org codex provider and serves the stored token afterwards", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "fresh-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
      },
      secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      secretConnectorMetadataMap: {
        CHATGPT_ACCESS_TOKEN: {
          sourceType: "model-provider" as const,
          sourceUserId: ORG_SENTINEL_USER_ID,
          metadataKey: "codex-oauth-token",
        },
      },
    };

    const refreshed = await fw.requestFirewallAuth(headers, body, [200]);
    if (refreshed.status !== 200) {
      throw new Error("Expected codex refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
    expect(refreshed.body.refreshedSecrets).toStrictEqual([
      "CHATGPT_ACCESS_TOKEN",
    ]);

    const served = await fw.requestFirewallAuth(headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected stored codex token to resolve");
    }
    expect(served.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(served.body.refreshedConnectors).toStrictEqual([]);
  });

  it("derives the model-provider source when metadata is omitted", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "derived-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected derived-source codex refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer derived-chatgpt-token",
    );
  });

  it("rejects cross-user model-provider sources and unknown aliases", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });

    const crossUser = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_ACCESS_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: "user_someone_else",
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [403],
    );
    expectApiError(crossUser.body);

    const unknownAlias = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_REFRESH_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_REFRESH_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_REFRESH_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: ORG_SENTINEL_USER_ID,
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [424],
    );
    if (unknownAlias.status !== 424) {
      throw new Error("Expected unknown codex alias to fail with 424");
    }
    expect(unknownAlias.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

    const userScoped = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_ACCESS_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: actor.userId,
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [424],
    );
    if (userScoped.status !== 424) {
      throw new Error("Expected user-scoped lookup to miss the org row");
    }
    expect(userScoped.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("recovers a reconnect-flagged codex provider after a successful refresh", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "recovered-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const recovered = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (recovered.status !== 200) {
      throw new Error("Expected reconnect-flagged refresh to recover");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer recovered-chatgpt-token",
    );
  });

  it("reports missing codex providers as not configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected missing codex provider to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});
