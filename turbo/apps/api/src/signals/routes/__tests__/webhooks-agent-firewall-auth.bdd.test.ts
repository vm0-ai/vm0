import { randomUUID } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { HttpResponse, http } from "msw";
import { delay } from "signal-timers";
import { describe, expect, it, onTestFinished } from "vitest";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { mockOptionalEnv } from "../../../lib/env";
import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../../lib/secret-kms-client";
import { now } from "../../../lib/time";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settle } from "../../utils";
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
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { setConnectorCredentialStorageState } from "./helpers/connector-credential-storage-state";

const ORG_SENTINEL_USER_ID = "__org__";
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

/**
 * HOOK-02 / FW: firewall auth template resolution and connector refresh
 * through POST /api/webhooks/agent/firewall/auth.
 *
 * Given state is constructed through public routes. The narrow test-only
 * connector credential state route is used only for persisted metadata that
 * an old deployment can leave behind but no production API exposes.
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
  const runsApi = createRunsApi(context);
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

function gateFirstStoredSecretDecrypt(): {
  readonly started: Promise<void>;
  readonly release: () => void;
} {
  const started = createDeferredPromise<void>(context.signal);
  const resume = createDeferredPromise<void>(context.signal);
  let decryptCalls = 0;
  const release = (): void => {
    if (!resume.settled()) {
      resume.resolve(undefined);
    }
  };
  onTestFinished(release);

  async function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  async function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  async function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      return {
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: TEST_DATA_KEY,
      };
    }

    decryptCalls += 1;
    // The encrypted request payload is first. The second decrypt starts after
    // the connector credential SELECT has captured its statement snapshot.
    if (decryptCalls === 2) {
      started.resolve(undefined);
      await resume.promise;
    }
    return { $metadata: {}, Plaintext: TEST_DATA_KEY };
  }

  const client: SecretKmsClient = { send };
  setSecretKmsClientForTests(client);
  return { started: started.promise, release };
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
          SCRAPENINJA_TOKEN: "rapidapi-secret",
          SHARED: "secret-shared",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
          "X-RapidAPI-Host": "scrapeninja.p.rapidapi.com",
          "X-RapidAPI-Key": secretTemplate("SCRAPENINJA_TOKEN"),
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
    expect(resolved.body.headers["X-RapidAPI-Host"]).toBe(
      "scrapeninja.p.rapidapi.com",
    );
    expect(resolved.body.headers["X-RapidAPI-Key"]).toBe("rapidapi-secret");
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
    expect(resolved.body.resolvedSecrets).toContain("SCRAPENINJA_TOKEN");
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

  it("passes literals through query templates and keeps basic-literal templates opaque", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    // The quoted basic arguments are literals: the embedded secret template
    // must neither be collected as a reference nor resolved, so the request
    // succeeds even though NEVER_SET is absent from the secret payload.
    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ PASS: "pass-secret" }),
        authHeaders: {
          "X-Empty-Basic": basicTemplate("", ""),
          "X-Literal-Template": basicTemplate(
            `"${secretTemplate("NEVER_SET")}"`,
            "secrets.PASS",
          ),
          "X-Quoted-Namespace": basicTemplate('"secrets.PASS"', "secrets.PASS"),
        },
        authQuery: {
          token: "literal-query-value",
          workspace: varTemplate("WORKSPACE_ID"),
        },
        vars: { WORKSPACE_ID: "workspace-9" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the literal template resolution to succeed");
    }
    expect(resolved.body.headers["X-Empty-Basic"]).toBe(
      `Basic ${Buffer.from(":").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Literal-Template"]).toBe(
      `Basic ${Buffer.from(`${secretTemplate("NEVER_SET")}:pass-secret`).toString("base64")}`,
    );
    expect(resolved.body.headers["X-Quoted-Namespace"]).toBe(
      `Basic ${Buffer.from("secrets.PASS:pass-secret").toString("base64")}`,
    );
    expect(resolved.body.query).toStrictEqual({
      token: "literal-query-value",
      workspace: "workspace-9",
    });
    expect(resolved.body.resolvedSecrets).toStrictEqual(["PASS"]);

    const withoutQuery = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: { Authorization: "Bearer static-token" },
      },
      [200],
    );
    if (withoutQuery.status !== 200) {
      throw new Error("Expected the query-less resolution to succeed");
    }
    expect(withoutQuery.body.query).toBeUndefined();
    expect(withoutQuery.body.headers.Authorization).toBe("Bearer static-token");
  });
});

describe("FW-3: billable firewall lease", () => {
  it("leases billable auth for limited-free-1 workspaces with spendable credits", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId ?? "",
      tier: "limited-free-1",
      credits: 20_000,
    });

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
      throw new Error("Expected limited-free-1 billable auth to succeed");
    }
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);
  });

  it("denies billable auth for pro-suspend workspaces even with credits", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId ?? "",
      tier: "pro-suspend",
      credits: 20_000,
    });

    const denied = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [402],
    );
    if (denied.status !== 402) {
      throw new Error("Expected pro-suspend billable auth to be denied");
    }
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

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

  it("merges the billable lease with refreshed connector token expiries", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });

    // A long-lived refreshed token leaves the 30 s billable lease as the
    // earlier bound.
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "long-lived-access",
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
      firewallBillable: true,
    };
    const leaseBefore = Math.floor(now() / 1000);
    const leaseBound = await fw.requestFirewallAuth(headers, body, [200]);
    if (leaseBound.status !== 200) {
      throw new Error("Expected the long-lived billable refresh to succeed");
    }
    expect(leaseBound.body.headers.Authorization).toBe(
      "Bearer long-lived-access",
    );
    expect(leaseBound.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      leaseBefore + 25,
    );
    expect(leaseBound.body.expiresAt ?? 0).toBeLessThanOrEqual(
      leaseBefore + 35,
    );

    // A short-lived refreshed token undercuts the lease and becomes the
    // effective expiry.
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "short-lived-access",
        expiresIn: 5,
      });
    });
    const tokenBefore = Math.floor(now() / 1000);
    const tokenBound = await fw.requestFirewallAuth(
      headers,
      {
        ...body,
        // The forced snapshot must match the stored token, otherwise the
        // request is served from the concurrently refreshed current access.
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "long-lived-access",
        }),
        forceRefresh: true,
      },
      [200],
    );
    if (tokenBound.status !== 200) {
      throw new Error("Expected the short-lived billable refresh to succeed");
    }
    expect(tokenBound.body.headers.Authorization).toBe(
      "Bearer short-lived-access",
    );
    expect(tokenBound.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      tokenBefore + 1,
    );
    expect(tokenBound.body.expiresAt ?? 0).toBeLessThanOrEqual(
      tokenBefore + 10,
    );
  });

  it("continues billable firewall auth after subscription deletion when credits remain", async () => {
    const bdd = createBddApi(context);
    const runsApi = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const fw = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    runsApi.configureRunnerGroup();
    const granted = await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD billable suspension agent",
      visibility: "private",
    });
    const run = await runsApi.createRun(actor, {
      agentId: agent.agentId,
      prompt: "billable auth across a subscription deletion",
      modelProvider: "anthropic-api-key",
    });
    const headers = fw.sandboxHeaders(actor, run.runId);
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("API_KEY")}`,
      },
      firewallBillable: true,
    };

    const leased = await fw.requestFirewallAuth(headers, body, [200]);
    if (leased.status !== 200) {
      throw new Error("Expected the entitled billable auth to lease");
    }
    expect(leased.body.expiresAt).not.toBeNull();

    webhooks.configureStripeBillingEnv();
    await webhooks.postStripeEvent(
      {
        id: `evt_bdd_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: granted.subscriptionId, metadata: {} } },
      },
      [200],
    );

    const downgraded = await runsApi.readBillingStatus(actor);
    expect(downgraded.tier).toBe("limited-free-1");
    expect(downgraded.subscriptionStatus).toBe("canceled");

    const postDeletionBefore = Math.floor(now() / 1000);
    const postDeletionLease = await fw.requestFirewallAuth(
      headers,
      body,
      [200],
    );
    if (postDeletionLease.status !== 200) {
      throw new Error("Expected the limited-free-1 billable auth to lease");
    }
    expect(postDeletionLease.body.expiresAt).not.toBeNull();
    expect(postDeletionLease.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      postDeletionBefore + 25,
    );
    expect(postDeletionLease.body.expiresAt ?? 0).toBeLessThanOrEqual(
      postDeletionBefore + 35,
    );

    await runsApi.requestCancelRun(actor, run.runId, [200]);
  });

  it("denies billable firewall auth when the granted credits already expired", async () => {
    const bdd = createBddApi(context);
    const runsApi = createRunsApi(context);
    const fw = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    runsApi.configureRunnerGroup();
    // The credit expiry is the subscription period end plus one month, so a
    // period that ended two months ago yields a pro org whose entire balance
    // is expired but unsettled.
    await runsApi.grantProEntitlement(actor, {
      periodEndUnix: Math.floor(now() / 1000) - 60 * 86_400,
    });
    await runsApi.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD expired-credit billable agent",
      visibility: "private",
    });
    const run = await runsApi.createRun(actor, {
      agentId: agent.agentId,
      prompt: "billable auth with expired credits",
      modelProvider: "anthropic-api-key",
    });

    const denied = await fw.requestFirewallAuth(
      fw.sandboxHeaders(actor, run.runId),
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [402],
    );
    if (denied.status !== 402) {
      throw new Error("Expected the expired-credit billable auth to be denied");
    }
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    await runsApi.requestCancelRun(actor, run.runId, [200]);
  });
});

describe("FW-4: connector refresh and replacement snapshots", () => {
  it("does not call the provider for a known storage version mismatch", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    await setConnectorCredentialStorageState(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorRef: "test-oauth",
      storageVersion: 2,
    });
    let providerCalls = 0;
    fw.mockTestOauthTokenRefresh(() => {
      providerCalls += 1;
      return fw.oauthTokenResponse({
        accessToken: "must-not-be-written",
        expiresIn: 3600,
      });
    });

    const response = await fw.requestFirewallAuth(
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
      [424],
    );
    if (response.status !== 424) {
      throw new Error("Expected mismatched storage version to be unavailable");
    }
    expect(response.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    expect(providerCalls).toBe(0);
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

  it("keeps multi-secret connector auth on one replacement snapshot", async () => {
    const fw = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.AwsConnector]: true,
    });
    const oldCredentials = {
      accessKeyId: "old-aws-access-key-id",
      secretAccessKey: "old-aws-secret-access-key",
      sessionToken: "old-aws-session-token",
    };
    const newCredentials = {
      accessKeyId: "new-aws-access-key-id",
      secretAccessKey: "new-aws-secret-access-key",
      sessionToken: "new-aws-session-token",
    };
    const provider = mockAwsExternalCodeProvider({
      credentialsByRequest: [oldCredentials, newCredentials],
    });

    async function connectAws(): Promise<void> {
      const session = await connectors.startExternalCode(actor, "aws", "cli");
      await connectors.completeExternalCode(actor, "aws", {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      });
    }

    await connectAws();
    const decryptGate = gateFirstStoredSecretDecrypt();
    const pendingAuth = fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "X-AWS-Access-Key-ID": secretTemplate("AWS_ACCESS_KEY_ID"),
          "X-AWS-Secret-Access-Key": secretTemplate("AWS_SECRET_ACCESS_KEY"),
          "X-AWS-Session-Token": secretTemplate("AWS_SESSION_TOKEN"),
        },
        secretConnectorMap: {
          AWS_ACCESS_KEY_ID: "aws",
          AWS_SECRET_ACCESS_KEY: "aws",
          AWS_SESSION_TOKEN: "aws",
        },
      },
      [200],
    );
    await decryptGate.started;
    const replacement = await settle(connectAws());
    decryptGate.release();
    const resolved = await pendingAuth;
    if (!replacement.ok) {
      throw replacement.error;
    }
    if (resolved.status !== 200) {
      throw new Error("Expected AWS firewall auth to resolve");
    }

    expect(provider.tokenRequests).toHaveLength(2);
    expect(resolved.body.headers).toStrictEqual({
      "X-AWS-Access-Key-ID": oldCredentials.accessKeyId,
      "X-AWS-Secret-Access-Key": oldCredentials.secretAccessKey,
      "X-AWS-Session-Token": oldCredentials.sessionToken,
    });

    await connectors.deleteConnectorByType(actor, "aws");
    await connectors.deleteFeatureSwitches(actor);
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

    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const failedConnector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(failedConnector.connectionStatus).toBe("reconnect-required");
    expect(failedConnector.reconnectReason).toBe(
      "authorization_expired_or_revoked",
    );

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
    const recoveredConnector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(recoveredConnector.connectionStatus).toBe("connected");
    expect(recoveredConnector.reconnectReason).toBeNull();
  });

  it("persists known OAuth refresh error subtypes as safe reconnect reasons", async () => {
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
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: "Session control expired",
          error_subtype: "invalid_rapt",
        },
        { status: 400 },
      );
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
      throw new Error("Expected invalid_rapt to fail with 502");
    }
    expect(failed.body.error.failureReason).toBe("reconnect_required");

    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(connector.connectionStatus).toBe("reconnect-required");
    expect(connector.reconnectReason).toBe("provider_session_expired");

    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json(
        { error: "temporarily_unavailable" },
        { status: 400 },
      );
    });
    const transientFailure = await fw.requestFirewallAuth(headers, body, [502]);
    if (transientFailure.status !== 502) {
      throw new Error("Expected temporary refresh failure to fail with 502");
    }
    expect(transientFailure.body.error.failureReason).toBe("upstream_provider");
    const preservedConnector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(preservedConnector.reconnectReason).toBe("provider_session_expired");
  });

  it("logs unknown OAuth refresh error subtypes without exposing them", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    const longSubtype = `invalid_rapt:${"x".repeat(200)}`;
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: "Session control expired",
          error_subtype: longSubtype,
        },
        { status: 400 },
      );
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

    context.mocks.axiomLogging.warn.mockClear();
    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected invalid_grant to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      expect.stringContaining("test-oauth token refresh failed"),
      expect.objectContaining({
        connectorType: "test-oauth",
        errorCode: "invalid_grant",
        failureReason: "reconnect_required",
        oauthError: "invalid_grant",
        oauthErrorSubtype: `${longSubtype.slice(0, 125)}...`,
        oauthStatus: 400,
      }),
    );

    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(connector.connectionStatus).toBe("reconnect-required");
    expect(connector.reconnectReason).toBeNull();
  });

  it("classifies transient OAuth refresh errors as upstream failures", async () => {
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
      return HttpResponse.json(
        { error: "temporarily_unavailable" },
        { status: 400 },
      );
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
      throw new Error("Expected temporarily_unavailable to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("upstream_provider");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-temporary-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected refresh after temporary outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer after-temporary-outage",
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

  it("requires reconnect when the stored connector never kept a refresh token", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      expiresIn: -60,
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
      throw new Error("Expected the refresh-token-less refresh to fail");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    // The connector is now flagged for reconnect and keeps failing without
    // reaching any provider endpoint.
    const flagged = await fw.requestFirewallAuth(headers, body, [502]);
    if (flagged.status !== 502) {
      throw new Error("Expected the flagged connector to keep failing");
    }
    expect(flagged.body.error.failureReason).toBe("reconnect_required");

    // The reconnect flag is visible through the public connector read.
    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connector = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(connector.connectionStatus).toBe("reconnect-required");
  });

  it("classifies refresh timeouts as upstream without marking reconnect", async () => {
    const fw = createFirewallApi(context);
    mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", "25");
    onTestFinished(() => {
      mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    });
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(async () => {
      await delay(300, { signal: context.signal });
      return fw.oauthTokenResponse({
        accessToken: "too-late",
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

    const timedOut = await fw.requestFirewallAuth(headers, body, [502]);
    if (timedOut.status !== 502) {
      throw new Error("Expected the refresh timeout to fail with 502");
    }
    expect(timedOut.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(timedOut.body.error.failureReason).toBe("upstream_provider");
    expect(timedOut.body.error.connectors).toStrictEqual(["test-oauth"]);

    // The connector was not flagged for reconnect: with the normal timeout
    // restored and a fast provider, the next call refreshes successfully.
    mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-timeout",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected the refresh after the timeout to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe("Bearer after-timeout");
    expect(recovered.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
  });

  it("classifies network refresh failures as upstream and recovers", async () => {
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
      return HttpResponse.error();
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
      throw new Error("Expected the network failure to fail with 502");
    }
    expect(failed.body.error.failureReason).toBe("upstream_provider");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-network-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected the refresh after the outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer after-network-outage",
    );
  });

  it("treats malformed and failing provider token responses as upstream failures", async () => {
    const fw = createFirewallApi(context);
    const connectorsApi = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    await connectorsApi.connectManualGrant(actor, "lark", "api-token", {
      appId: "lark-app-id",
      appSecret: "lark-app-secret",
    });
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          return HttpResponse.json({ code: 0, msg: "ok" });
        },
      ),
    );

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("LARK_TOKEN")}`,
      },
      secretConnectorMap: { LARK_TOKEN: "lark" },
    };

    const malformed = await fw.requestFirewallAuth(headers, body, [502]);
    if (malformed.status !== 502) {
      throw new Error("Expected the malformed lark response to fail with 502");
    }
    expect(malformed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(malformed.body.error.failureReason).toBe("upstream_provider");
    expect(malformed.body.error.connectors).toStrictEqual(["lark"]);

    // Provider HTTP failures classify the same way without flagging the
    // connector for reconnect.
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          return new HttpResponse(null, { status: 500 });
        },
      ),
    );
    const failing = await fw.requestFirewallAuth(headers, body, [502]);
    if (failing.status !== 502) {
      throw new Error("Expected the failing lark endpoint to fail with 502");
    }
    expect(failing.body.error.failureReason).toBe("upstream_provider");
    expect(failing.body.error.connectors).toStrictEqual(["lark"]);
  });

  it("refreshes mapped-input connector access and stores its variable outputs", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth",
      authMethod: "api",
      accessToken: "stale-api-access",
      refreshToken: "api-refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "fresh-api-access",
        refreshToken: "api-refresh-2",
        expiresIn: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-api-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
    };

    const refreshed = await fw.requestFirewallAuth(headers, body, [200]);
    if (refreshed.status !== 200) {
      throw new Error("Expected the mapped-input refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer fresh-api-access",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(refreshed.body.refreshedSecrets).toStrictEqual(["TEST_OAUTH_TOKEN"]);

    const served = await fw.requestFirewallAuth(headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected the stored mapped-input token to resolve");
    }
    expect(served.body.headers.Authorization).toBe("Bearer fresh-api-access");
    expect(served.body.refreshedConnectors).toStrictEqual([]);
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
      apiToken: "manual-secret",
      inputVariable: "manual-var",
      tenantId: "tenant-x",
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

  it("serves static device tokens that were stored without an expiry", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "no-expiry-device",
    });

    const synced = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_DEVICE_TOKEN")}`,
        },
        secretConnectorMap: { TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device" },
      },
      [200],
    );
    if (synced.status !== 200) {
      throw new Error("Expected the expiry-less static token to resolve");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer no-expiry-device");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
    expect(synced.body.expiresAt).toBeNull();
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
  it("resolves static model-provider auth from an empty runtime namespace", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "x-api-key": secretTemplate("ANTHROPIC_API_KEY"),
        },
        secretConnectorMap: { ANTHROPIC_API_KEY: "anthropic-api-key" },
        secretConnectorMetadataMap: {
          ANTHROPIC_API_KEY: {
            sourceType: "model-provider" as const,
            sourceUserId: ORG_SENTINEL_USER_ID,
            metadataKey: "anthropic-api-key",
          },
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected static model-provider auth to resolve");
    }
    expect(resolved.body.headers["x-api-key"]).toBe("test-anthropic-key");
    expect(resolved.body.resolvedSecrets).toStrictEqual(["ANTHROPIC_API_KEY"]);
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
  });

  it("derives static model-provider auth when metadata is omitted", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "x-api-key": secretTemplate("ANTHROPIC_API_KEY"),
        },
        secretConnectorMap: { ANTHROPIC_API_KEY: "anthropic-api-key" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected derived static model-provider auth to resolve");
    }
    expect(resolved.body.headers["x-api-key"]).toBe("test-anthropic-key");
    expect(resolved.body.resolvedSecrets).toStrictEqual(["ANTHROPIC_API_KEY"]);
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
  });

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

  it("re-refreshes reconnect-flagged codex providers before their token expires", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "current-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: 3600,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "reauthorized-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "current-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected the unexpired reconnect refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer reauthorized-chatgpt-token",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
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

  it("preserves chatgpt reconnect error codes on codex refresh failure", async () => {
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
      return HttpResponse.json(
        {
          error: {
            code: "refresh_token_expired",
            message: "expired refresh token",
          },
        },
        { status: 401 },
      );
    });

    const failed = await fw.requestFirewallAuth(
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
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected the chatgpt reconnect failure to be 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["codex-oauth-token"]);
  });

  it("omits the failure reason for unknown chatgpt refresh error codes", async () => {
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
      return HttpResponse.json(
        {
          error: {
            code: "totally_novel_failure",
            message: "unrecognized refresh failure",
          },
        },
        { status: 401 },
      );
    });

    const failed = await fw.requestFirewallAuth(
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
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected the unknown chatgpt failure to be 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBeUndefined();
    expect(failed.body.error.connectors).toStrictEqual(["codex-oauth-token"]);
  });
});

describe("FW-10: platform connector secrets", () => {
  it("resolves platform-secret aliases from current API env", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token-current");

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("GOOGLE_ADS_TOKEN")}`,
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        secretConnectorMap: {
          GOOGLE_ADS_TOKEN: "google-ads",
          GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected platform-secret alias to resolve");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer google-ads-access",
    );
    expect(resolved.body.headers["developer-token"]).toBe(
      "developer-token-current",
    );
    expect(resolved.body.resolvedSecrets).toStrictEqual([
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_TOKEN",
    ]);
  });

  it("reports missing platform env as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
    await installApiTestConnectorCatalog();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        secretConnectorMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected missing platform env to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("does not fall back to stale encrypted values for platform metadata", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", " ");

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_DEVELOPER_TOKEN: "stale-developer-token",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        secretConnectorMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected stale encrypted platform value to be ignored");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("rejects platform metadata for non-platform connector aliases", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorName: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token-current");

    const invalid = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("GOOGLE_ADS_TOKEN")}`,
        },
        secretConnectorMap: {
          GOOGLE_ADS_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (invalid.status !== 424) {
      throw new Error("Expected invalid platform alias to fail with 424");
    }
    expect(invalid.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("keeps old encrypted platform-secret payloads working without metadata", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
    await installApiTestConnectorCatalog();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_DEVELOPER_TOKEN: "old-encrypted-developer-token",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected old encrypted platform payload to resolve");
    }
    expect(resolved.body.headers["developer-token"]).toBe(
      "old-encrypted-developer-token",
    );
  });
});

describe("FW-11: aws sigv4 template resolution", () => {
  it("resolves aws sigv4 credentials from secret and var templates", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          AWS_SECRET_ACCESS_KEY: "secret-access-key",
          AWS_SESSION_TOKEN: "session-token",
        }),
        authHeaders: {},
        authAwsSigv4: {
          accessKeyId: varTemplate("AWS_ACCESS_KEY_ID"),
          secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
          sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
        },
        vars: { AWS_ACCESS_KEY_ID: "access-key-id" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the sigv4 resolution to succeed");
    }
    expect(resolved.body.headers).toStrictEqual({});
    expect(resolved.body.awsSigv4).toStrictEqual({
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      sessionToken: "session-token",
    });
    expect(resolved.body.resolvedSecrets).toStrictEqual([
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expect(resolved.body.expiresAt).toBeNull();
  });

  it("rejects empty resolved aws sigv4 credentials as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          AWS_ACCESS_KEY_ID: "",
          AWS_SECRET_ACCESS_KEY: "secret-access-key",
        }),
        authHeaders: {},
        authAwsSigv4: {
          accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
          secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected the empty sigv4 credential to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});
