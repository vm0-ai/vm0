import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import { connectors } from "@vm0/db/schema/connector";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  decryptSecretValue,
  encryptSecretValue,
  encryptSecretsMap,
} from "../../services/crypto.utils";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const ORG_SENTINEL_USER_ID = "__org__";

interface FirewallFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    runId: fixture.runId,
    userId: fixture.userId,
    orgId: fixture.orgId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function authHeaders(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): { readonly authorization: string } {
  return { authorization: `Bearer ${sandboxToken(fixture)}` };
}

function encryptedSecrets(values: Record<string, string>): string {
  const encrypted = encryptSecretsMap(values);
  if (!encrypted) {
    throw new Error("encryptSecretsMap returned null for non-empty secrets");
  }
  return encrypted;
}

function secretTemplate(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function varTemplate(name: string): string {
  return `\${{ vars.${name} }}`;
}

function basicTemplate(first: string, second: string): string {
  return `\${{ basic(${first}, ${second}) }}`;
}

function firewallClient() {
  return setupApp({ context })(webhookFirewallAuthContract);
}

async function seedFixture(): Promise<FirewallFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      status: "running",
    },
    context.signal,
  );
  return { ...base, composeId, runId };
}

const track = createFixtureTracker<FirewallFixture>(async (fixture) => {
  const db = store.set(writeDb$);
  await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await db
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, fixture.orgId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, fixture.orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function seedSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
  readonly type: "connector" | "model-provider";
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(secrets).values({
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    encryptedValue: encryptSecretValue(args.value),
    type: args.type,
  });
}

async function seedCreditState(
  fixture: FirewallFixture,
  args: {
    readonly credits: number;
    readonly creditEnabled?: boolean;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits: args.credits,
  });
  await db.insert(orgMembersMetadata).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    creditEnabled: args.creditEnabled ?? true,
  });
}

async function seedOrgCredits(
  fixture: FirewallFixture,
  args: {
    readonly credits: number;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits: args.credits,
  });
}

async function readSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: "connector" | "model-provider";
}): Promise<string | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, args.type),
      ),
    )
    .limit(1);
  return row ? decryptSecretValue(row.encryptedValue) : null;
}

async function seedExpiredNotionConnector(
  fixture: FirewallFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "notion",
    authMethod: "oauth",
    externalId: "notion-user",
    externalUsername: "notion-user",
    externalEmail: "notion@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: new Date(now() - 60_000),
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "NOTION_ACCESS_TOKEN",
    value: "stale-notion-token",
    type: "connector",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "NOTION_REFRESH_TOKEN",
    value: "notion-refresh-token",
    type: "connector",
  });
}

async function seedExpiredCodexModelProvider(
  fixture: FirewallFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(modelProviders).values({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    type: "codex-oauth-token",
    authMethod: "auth_json",
    tokenExpiresAt: new Date(now() - 60_000),
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_ACCESS_TOKEN",
    value: "stale-chatgpt-token",
    type: "model-provider",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_REFRESH_TOKEN",
    value: "chatgpt-refresh-token",
    type: "model-provider",
  });
}

async function notionConnectorState(fixture: FirewallFixture): Promise<{
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      needsReconnect: connectors.needsReconnect,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
        eq(connectors.type, "notion"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("notion connector state not found");
  }
  return row;
}

async function codexProviderState(fixture: FirewallFixture): Promise<{
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly tokenExpiresAt: Date | null;
}> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      needsReconnect: modelProviders.needsReconnect,
      lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      tokenExpiresAt: modelProviders.tokenExpiresAt,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, fixture.orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, "codex-oauth-token"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("codex provider state not found");
  }
  return row;
}

beforeEach(() => {
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-secret");
});

describe("POST /api/webhooks/agent/firewall/auth", () => {
  it("rejects missing sandbox auth before parsing the body", async () => {
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Missing authorization", code: "UNAUTHORIZED" },
    });
  });

  it("rejects invalid sandbox tokens", async () => {
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: { authorization: "Bearer invalid-token" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid token", code: "UNAUTHORIZED" },
    });
  });

  it("rejects invalid JSON bodies", async () => {
    const fixture = await track(seedFixture());
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/webhooks/agent/firewall/auth", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sandboxToken(fixture)}`,
        "content-type": "application/json",
      },
      body: "{",
    });

    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Invalid JSON body", code: "BAD_REQUEST" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects invalid bodies and decrypt failures", async () => {
    const fixture = await track(seedFixture());

    const invalidBody = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: "",
          authHeaders: {},
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(invalidBody.body).toStrictEqual({
      error: {
        message: "encryptedSecrets and authHeaders are required",
        code: "BAD_REQUEST",
      },
    });

    const decryptFailure = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: "not-encrypted",
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(decryptFailure.body).toStrictEqual({
      error: { message: "Failed to decrypt secrets", code: "BAD_REQUEST" },
    });
  });

  it("returns connector-not-configured for missing referenced secrets or vars", async () => {
    const fixture = await track(seedFixture());

    const missingSecret = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(missingSecret.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });

    const missingVar = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: { "X-Workspace": varTemplate("WORKSPACE_ID") },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(missingVar.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("resolves simple and basic auth templates", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            API_TOKEN: "secret-token",
            BASIC_PASSWORD: "secret-password",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
            "X-Basic": basicTemplate(
              "vars.BASIC_USER",
              "secrets.BASIC_PASSWORD",
            ),
          },
          authBase: `https://${varTemplate("SUBDOMAIN")}.example.com`,
          authQuery: {
            workspace: varTemplate("WORKSPACE_ID"),
            token: secretTemplate("API_TOKEN"),
          },
          vars: {
            BASIC_USER: "user",
            SUBDOMAIN: "api",
            WORKSPACE_ID: "workspace-1",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      headers: {
        Authorization: "Bearer secret-token",
        "X-Basic": `Basic ${Buffer.from("user:secret-password").toString(
          "base64",
        )}`,
      },
      base: "https://api.example.com",
      query: {
        workspace: "workspace-1",
        token: "secret-token",
      },
      expiresAt: null,
      resolvedSecrets: ["API_TOKEN", "BASIC_PASSWORD"],
      refreshedConnectors: [],
      refreshedSecrets: [],
    });
  });

  it("returns a bounded expiry for billable firewall auth", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    const after = currentSecond();
    expect(response.body.headers.Authorization).toBe("Bearer secret-token");
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 30);
  });

  it("allows billable firewall auth when member credit metadata is absent", async () => {
    const fixture = await track(seedFixture());
    await seedOrgCredits(fixture, { credits: 10_000 });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe("Bearer secret-token");
    expect(response.body.expiresAt).toBeTypeOf("number");
  });

  it("denies billable firewall auth when expired credits have not been settled", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 100 });

    const db = store.set(writeDb$);
    await db.insert(creditExpiresRecord).values({
      orgId: fixture.orgId,
      source: "starter_grant",
      amount: 100,
      remaining: 100,
      expiresAt: new Date(now() - 60_000),
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("denies billable firewall auth when credits are exhausted", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 0 });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it("denies billable firewall auth when member credit is disabled", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000, creditEnabled: false });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("denies billable firewall auth when credit state is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("refreshes expired connector OAuth tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-notion-token",
          refresh_token: "new-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["notion"]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "NOTION_ACCESS_TOKEN",
    ]);
    expect(response.body.expiresAt).toBeGreaterThan(currentSecond());
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-notion-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("new-notion-refresh-token");
    const connector = await notionConnectorState(fixture);
    expect(connector.needsReconnect).toBeFalsy();
    expect(connector.tokenExpiresAt?.getTime()).toBeGreaterThan(now());
  });

  it("uses OAuth token expiry when it is earlier than billable credit lease", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "short-lived-notion-token",
          expires_in: 10,
        });
      }),
    );

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const after = currentSecond();

    expect(response.body.headers.Authorization).toBe(
      "Bearer short-lived-notion-token",
    );
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 10);
  });

  it("uses billable credit lease when it is earlier than OAuth token expiry", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "long-lived-notion-token",
          expires_in: 3600,
        });
      }),
    );

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const after = currentSecond();

    expect(response.body.headers.Authorization).toBe(
      "Bearer long-lived-notion-token",
    );
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 30);
  });

  it("returns token-refresh-failed and marks connector reconnect when refresh fails", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "revoked" },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("refreshes expired codex model-provider OAuth tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-chatgpt-token",
          refresh_token: "rotated-chatgpt-refresh",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["codex-oauth"]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "CHATGPT_ACCESS_TOKEN",
    ]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("fresh-chatgpt-token");
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("rejects model-provider refresh metadata for another user before billable credit auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: `user_${randomUUID()}`,
              metadataKey: "codex-oauth-token",
            },
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid model-provider secret owner",
        code: "FORBIDDEN",
      },
    });
  });

  it("preserves ChatGPT refresh error codes on model-provider refresh failure", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "expired refresh token",
            },
          },
          { status: 401 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["codex-oauth"],
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });
});
