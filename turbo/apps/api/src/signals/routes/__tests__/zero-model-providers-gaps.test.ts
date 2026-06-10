import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { createStore } from "ccstate";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

interface ProviderCleanup {
  readonly owner: Actor;
  readonly type: ModelProviderType;
}

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mainClient() {
  return setupApp({ context })(zeroModelProvidersMainContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroModelProvidersByTypeContract);
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeIdToken(opts: {
  readonly accountId: string;
  readonly planType: string;
  readonly workspaceName?: string;
}): string {
  const auth: Record<string, unknown> = {
    chatgpt_account_id: opts.accountId,
    chatgpt_plan_type: opts.planType,
  };
  if (opts.workspaceName !== undefined) {
    auth.organization = { title: opts.workspaceName };
  }
  return makeJwt({
    "https://api.openai.com/auth": auth,
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeAuthJson(overrides?: { readonly refreshToken?: string }): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: makeJwt({ exp: accessExp }),
      refresh_token: overrides?.refreshToken ?? "rt_org_synthetic_high_entropy",
      account_id: "ws_acct_plain",
      id_token: makeIdToken({
        accountId: "ws_acct_from_id_token_org",
        planType: "plus",
        workspaceName: "Org Acme",
      }),
    },
  });
}

async function deleteProvider(
  owner: Actor,
  type: ModelProviderType,
): Promise<void> {
  mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
  await accept(
    byTypeClient().delete({
      params: { type },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

const trackProviderCleanup = createFixtureTracker<ProviderCleanup>(
  async (provider) => {
    await deleteProvider(provider.owner, provider.type);
  },
);

async function trackProvider(
  owner: Actor,
  type: ModelProviderType,
): Promise<void> {
  await trackProviderCleanup(Promise.resolve({ owner, type }));
}

async function markOrgProviderStale(
  orgId: string,
  type: ModelProviderType,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(modelProviders)
    .set({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, type),
      ),
    );
}

async function markOrgProviderDefault(
  orgId: string,
  type: ModelProviderType,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(modelProviders)
    .set({ isDefault: true })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, type),
      ),
    );
}

describe("/api/zero/model-providers helper gaps", () => {
  it("surfaces and clears legacy reconnect metadata on an API-created Codex provider", async () => {
    const owner = actor();
    const main = mainClient();
    await trackProvider(owner, "codex-oauth-token");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    await accept(
      main.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    await markOrgProviderStale(owner.orgId, "codex-oauth-token");

    const stale = await accept(main.list({ headers: authHeaders() }), [200]);
    const staleProvider = stale.body.modelProviders.find((provider) => {
      return provider.type === "codex-oauth-token";
    });

    expect(staleProvider).toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });

    const repaste = await accept(
      main.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({
              refreshToken: "rt_fresh_org",
            }),
          },
        },
        headers: authHeaders(),
      }),
      [200],
    );
    const fresh = await accept(main.list({ headers: authHeaders() }), [200]);
    const freshProvider = fresh.body.modelProviders.find((provider) => {
      return provider.type === "codex-oauth-token";
    });

    expect(repaste.body.provider.needsReconnect).toBeFalsy();
    expect(repaste.body.provider.lastRefreshErrorCode).toBeNull();
    expect(freshProvider).toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("does not promote another provider after deleting a legacy default row", async () => {
    const owner = actor();
    const main = mainClient();
    const byType = byTypeClient();
    await trackProvider(owner, "anthropic-api-key");
    await trackProvider(owner, "openai-api-key");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    await accept(
      main.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: authHeaders(),
      }),
      [201],
    );
    await accept(
      main.upsert({
        body: { type: "openai-api-key", secret: "sk-proj-test" },
        headers: authHeaders(),
      }),
      [201],
    );
    await markOrgProviderDefault(owner.orgId, "anthropic-api-key");

    await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [204],
    );
    const remaining = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(remaining.body.modelProviders).toHaveLength(1);
    expect(remaining.body.modelProviders[0]).toMatchObject({
      type: "openai-api-key",
      isDefault: false,
    });
  });
});
