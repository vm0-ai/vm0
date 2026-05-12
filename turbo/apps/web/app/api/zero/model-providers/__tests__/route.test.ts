import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET, POST } from "../route";
import { DELETE } from "../[type]/route";
import {
  createTestRequest,
  setTestModelProviderNeedsReconnect,
  findTestConnectorSecret,
  findTestModelProviderTokenState,
  ORG_SENTINEL_USER_ID,
} from "../../../../../src/__tests__/api-test-helpers";
import { insertOrgMultiAuthModelProvider } from "../../../../../src/__tests__/db-test-seeders/org";
import { insertTestOrgModelProviderSecret } from "../../../../../src/__tests__/db-test-seeders/secrets";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/model-providers";

function listUrl(): string {
  return BASE_URL;
}

function upsertUrl(): string {
  return BASE_URL;
}

function deleteUrl(type: string): string {
  return `${BASE_URL}/${type}`;
}

async function expectUnauthorized(
  responsePromise: Promise<Response> | Response,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(401);
  const data = await response.json();
  expect(data.error.code).toBe("UNAUTHORIZED");
}

async function listProviders(): Promise<
  Array<{
    id: string;
    type: string;
    framework: string;
    secretName: string;
    authMethod: string | null;
    secretNames: string[] | null;
    isDefault: boolean;
    selectedModel: string | null;
    needsReconnect: boolean;
    lastRefreshErrorCode: string | null;
  }>
> {
  const request = createTestRequest(listUrl());
  const response = await GET(request);
  const data = await response.json();
  return data.modelProviders;
}

async function createProvider(
  type: string,
  secret: string,
  selectedModel?: string,
) {
  const request = createTestRequest(upsertUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, secret, selectedModel }),
  });
  return POST(request);
}

async function createMultiAuthProvider(
  type: string,
  authMethod: string,
  secrets: Record<string, string>,
  selectedModel?: string,
) {
  const request = createTestRequest(upsertUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, authMethod, secrets, selectedModel }),
  });
  return POST(request);
}

describe("Org-level model provider routes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    void user;
  });

  describe("no active organization", () => {
    beforeEach(() => {
      mockClerk({ userId: user.userId, orgId: null });
    });

    it("GET returns 401", async () => {
      await expectUnauthorized(GET(createTestRequest(listUrl())));
    });

    it("POST returns 401", async () => {
      await expectUnauthorized(createProvider("anthropic-api-key", "test-key"));
    });

    it("DELETE returns 401", async () => {
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      await expectUnauthorized(DELETE(request));
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/zero/model-providers  (list)
  // ---------------------------------------------------------------------------

  describe("GET /api/zero/model-providers", () => {
    it("should return empty list when no org providers exist", async () => {
      const request = createTestRequest(listUrl());
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.modelProviders).toEqual([]);
    });

    it("should list org providers", async () => {
      await createProvider("anthropic-api-key", "test-org-key");

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("anthropic-api-key");
    });

    it("should not mark the first provider as default", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const providers = await listProviders();
      expect(providers[0]?.isDefault).toBe(false);
    });

    it("should not mark same-framework providers as default", async () => {
      await createProvider("anthropic-api-key", "key-1");
      await createProvider("claude-code-oauth-token", "token-1");

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const oauth = providers.find((p) => {
        return p.type === "claude-code-oauth-token";
      });
      expect(anthropic!.isDefault).toBe(false);
      expect(oauth!.isDefault).toBe(false);
    });

    it("does not mark provider rows as framework defaults via list", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const providers = await listProviders();
      const frameworkDefaultProvider = providers.find((p) => {
        return p.isDefault && p.framework === "claude-code";
      });
      expect(frameworkDefaultProvider).toBeUndefined();
    });

    it("should have no default for framework when no providers exist", async () => {
      const providers = await listProviders();
      const defaultProvider = providers.find((p) => {
        return p.isDefault && p.framework === "claude-code";
      });
      expect(defaultProvider).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/model-providers  (upsert)
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/model-providers", () => {
    it("should create an org provider", async () => {
      const response = await createProvider(
        "anthropic-api-key",
        "test-org-key",
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.provider.type).toBe("anthropic-api-key");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.secretName).toBe("ANTHROPIC_API_KEY");
      expect(data.provider.isDefault).toBe(false);
    });

    it("should update existing org provider on re-upsert", async () => {
      const response1 = await createProvider("anthropic-api-key", "key-v1");
      const data1 = await response1.json();

      const response2 = await createProvider("anthropic-api-key", "key-v2");
      const data2 = await response2.json();

      expect(data2.created).toBe(false);
      expect(data2.provider.id).toBe(data1.provider.id);
    });

    it("should ignore provider-level selectedModel", async () => {
      const response = await createProvider(
        "moonshot-api-key",
        "test-key",
        "kimi-k2.5",
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.provider.selectedModel).toBeNull();
    });

    it("should create org-level AWS Bedrock provider", async () => {
      const response = await createMultiAuthProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.provider.type).toBe("aws-bedrock");
      expect(data.provider.authMethod).toBe("access-keys");
      expect(data.provider.secretNames).toContain("AWS_ACCESS_KEY_ID");
      expect(data.provider.secretNames).toContain("AWS_SECRET_ACCESS_KEY");
      expect(data.provider.secretNames).toContain("AWS_REGION");
    });

    it("should reject single-secret provider type in multi-auth", async () => {
      const response = await createMultiAuthProvider(
        "anthropic-api-key" as ModelProviderType,
        "api-key",
        { ANTHROPIC_API_KEY: "test" },
      );

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/zero/model-providers/[type]
  // ---------------------------------------------------------------------------

  describe("DELETE /api/zero/model-providers/[type]", () => {
    it("should delete an org provider", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);

      const providers = await listProviders();
      expect(providers).toEqual([]);
    });

    it("should return 404 when deleting non-existent org provider", async () => {
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(404);
    });

    it("should not promote a remaining provider on delete", async () => {
      await createProvider("anthropic-api-key", "key-1");
      await createProvider("claude-code-oauth-token", "token-1");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      await DELETE(request);

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("claude-code-oauth-token");
      expect(providers[0]?.isDefault).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // codex-beta gate on POST /api/zero/model-providers
  // ---------------------------------------------------------------------------

  describe("openai-api-key codex-beta gate", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation(() => {
        return true;
      });
    });

    it("creates openai-api-key provider when codex-beta is enabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key === FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider(
        "openai-api-key",
        "sk-proj-test",
        "gpt-5.5",
      );
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("openai-api-key");
      expect(data.provider.framework).toBe("codex");
    });

    it("returns 404 when codex-beta is disabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider(
        "openai-api-key",
        "sk-proj-test",
        "gpt-5.5",
      );
      expect(response.status).toBe(404);
    });

    it("does not gate other provider types when codex-beta is disabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider("anthropic-api-key", "sk-ant-test");
      expect(response.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-framework providers no longer maintain provider-level defaults.
  // ---------------------------------------------------------------------------

  describe("cross-framework providers", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation(() => {
        return true;
      });
    });

    it("does not mark any cross-framework provider as default", async () => {
      await createProvider("anthropic-api-key", "ant-key");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const openai = providers.find((p) => {
        return p.type === "openai-api-key";
      });

      expect(anthropic!.isDefault).toBe(false);
      expect(openai!.isDefault).toBe(false);
      expect(
        providers.filter((p) => {
          return p.isDefault;
        }),
      ).toHaveLength(0);
    });

    it("delete does not promote the remaining cross-framework provider", async () => {
      await createProvider("anthropic-api-key", "ant-key");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      await DELETE(request);

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("openai-api-key");
      expect(providers[0]?.isDefault).toBe(false);
    });
  });

  describe("GET — surfaces OAuth refresh state on every provider (#11932)", () => {
    let user: UserContext;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockIsFeatureEnabled.mockReturnValue(true);
      context.setupMocks();
      user = await context.setupUser();
    });

    it("emits needsReconnect=false + lastRefreshErrorCode=null for healthy providers", async () => {
      await createProvider("anthropic-api-key", "sk-ant-test");
      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      const p = providers[0];
      expect(p?.needsReconnect).toBe(false);
      expect(p?.lastRefreshErrorCode).toBeNull();
    });

    it("emits needsReconnect=true + lastRefreshErrorCode after firewall refresh failure", async () => {
      // Seed directly via DB helpers — the upsert route's auth_json branch is
      // a paste-flow special case that expects CODEX_AUTH_JSON, not the four
      // pre-derived CHATGPT_* secrets this test feeds.
      await insertOrgMultiAuthModelProvider(
        user.orgId,
        "codex-oauth-token",
        "auth_json",
      );
      for (const [name, value] of [
        ["CHATGPT_ACCESS_TOKEN", "at"],
        ["CHATGPT_REFRESH_TOKEN", "rt"],
        ["CHATGPT_ACCOUNT_ID", "acct"],
        ["CHATGPT_ID_TOKEN", "idt"],
      ] as const) {
        await insertTestOrgModelProviderSecret({
          orgId: user.orgId,
          name,
          value,
        });
      }
      await setTestModelProviderNeedsReconnect(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
        true,
        "refresh_token_expired",
      );

      const providers = await listProviders();
      const stale = providers.find((p) => {
        return p.type === "codex-oauth-token";
      });
      expect(stale).toBeDefined();
      expect(stale?.needsReconnect).toBe(true);
      expect(stale?.lastRefreshErrorCode).toBe("refresh_token_expired");
    });
  });

  // ---------------------------------------------------------------------------
  // codex-oauth-token auth_json paste flow
  // ---------------------------------------------------------------------------

  describe("codex-oauth-token auth_json paste flow", () => {
    function base64UrlEncode(input: string): string {
      return Buffer.from(input, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }

    function makeJwt(payload: Record<string, unknown>): string {
      const header = base64UrlEncode(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      );
      const body = base64UrlEncode(JSON.stringify(payload));
      return `${header}.${body}.fake-signature`;
    }

    function makeIdToken(opts: {
      accountId: string;
      planType: string;
      workspaceName?: string;
      exp?: number;
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
        exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600,
      });
    }

    function makeAuthJson(overrides?: {
      accessToken?: string;
      refreshToken?: string;
      idToken?: string;
      planType?: string;
    }): string {
      const accessExp = Math.floor(Date.now() / 1000) + 7200;
      return JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: overrides?.accessToken ?? makeJwt({ exp: accessExp }),
          refresh_token:
            overrides?.refreshToken ?? "rt_synthetic_test_high_entropy",
          account_id: "ws_acct_plain",
          id_token:
            overrides?.idToken ??
            makeIdToken({
              accountId: "ws_acct_from_id_token",
              planType: overrides?.planType ?? "plus",
              workspaceName: "Acme Corp",
            }),
        },
      });
    }

    async function pasteAuthJson(rawJson: string): Promise<Response> {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: rawJson },
        }),
      });
      return POST(request);
    }

    it("happy path: paste valid auth.json persists 4 derived secrets and metadata", async () => {
      const response = await pasteAuthJson(makeAuthJson());
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("codex-oauth-token");
      expect(data.provider.authMethod).toBe("auth_json");
      expect(data.provider.workspaceName).toBe("Acme Corp");
      expect(data.provider.planType).toBe("plus");
      expect(data.provider.needsReconnect).toBe(false);

      // The four derived CHATGPT_* fields are persisted
      const access = await findTestConnectorSecret(
        user.orgId,
        "CHATGPT_ACCESS_TOKEN",
        "model-provider",
      );
      const refresh = await findTestConnectorSecret(
        user.orgId,
        "CHATGPT_REFRESH_TOKEN",
        "model-provider",
      );
      const accountId = await findTestConnectorSecret(
        user.orgId,
        "CHATGPT_ACCOUNT_ID",
        "model-provider",
      );
      const idToken = await findTestConnectorSecret(
        user.orgId,
        "CHATGPT_ID_TOKEN",
        "model-provider",
      );
      expect(access).toBeTypeOf("string");
      expect(refresh).toBe("rt_synthetic_test_high_entropy");
      // accountId comes from id_token claim, NOT tokens.account_id
      expect(accountId).toBe("ws_acct_from_id_token");
      expect(accountId).not.toBe("ws_acct_plain");
      expect(idToken).toBeTypeOf("string");

      // Metadata persisted on the row
      const state = await findTestModelProviderTokenState(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(state).not.toBeNull();
      expect(state!.tokenExpiresAt).toBeInstanceOf(Date);
      expect(state!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(state!.workspaceName).toBe("Acme Corp");
      expect(state!.planType).toBe("plus");
      expect(state!.needsReconnect).toBe(false);
      expect(state!.lastRefreshErrorCode).toBeNull();
    });

    it("never persists the raw CODEX_AUTH_JSON blob", async () => {
      const response = await pasteAuthJson(makeAuthJson());
      expect(response.status).toBe(201);

      // Defense-in-depth: the raw blob must not appear under the wire-shape key
      const rawUpper = await findTestConnectorSecret(
        user.orgId,
        "CODEX_AUTH_JSON",
        "model-provider",
      );
      const rawLower = await findTestConnectorSecret(
        user.orgId,
        "codex_auth_json",
        "model-provider",
      );
      expect(rawUpper).toBeUndefined();
      expect(rawLower).toBeUndefined();
    });

    it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID on malformed JSON", async () => {
      const response = await pasteAuthJson("{ not json");
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    });

    it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID when tokens.refresh_token is missing", async () => {
      const incomplete = JSON.stringify({
        tokens: {
          access_token: makeJwt({ exp: Date.now() }),
          // refresh_token omitted
          account_id: "ws_acct",
          id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
        },
      });
      const response = await pasteAuthJson(incomplete);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    });

    it("returns 400 CODEX_FREE_PLAN_REJECTED for free-plan accounts", async () => {
      const response = await pasteAuthJson(makeAuthJson({ planType: "free" }));
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("CODEX_FREE_PLAN_REJECTED");
    });

    it("returns 400 BAD_REQUEST when CODEX_AUTH_JSON is missing from secrets", async () => {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("re-paste atomically clears needsReconnect and lastRefreshErrorCode", async () => {
      // First paste — provider becomes healthy
      await pasteAuthJson(makeAuthJson());

      // Pretend the firewall refresh pipeline marked it stale
      await setTestModelProviderNeedsReconnect(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
        true,
        "refresh_token_expired",
      );

      const beforeReset = await findTestModelProviderTokenState(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(beforeReset?.needsReconnect).toBe(true);
      expect(beforeReset?.lastRefreshErrorCode).toBe("refresh_token_expired");

      // User re-pastes a fresh auth.json
      const newAccess = makeJwt({
        exp: Math.floor(Date.now() / 1000) + 7200,
        sub: "fresh",
      });
      const response = await pasteAuthJson(
        makeAuthJson({ accessToken: newAccess, refreshToken: "rt_fresh" }),
      );
      expect(response.status).toBe(200);

      const afterReset = await findTestModelProviderTokenState(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(afterReset?.needsReconnect).toBe(false);
      expect(afterReset?.lastRefreshErrorCode).toBeNull();

      // The new refresh token replaced the old one
      const refresh = await findTestConnectorSecret(
        user.orgId,
        "CHATGPT_REFRESH_TOKEN",
        "model-provider",
      );
      expect(refresh).toBe("rt_fresh");
    });

    it("returns 404 when codexOauthProvider feature switch is disabled", async () => {
      // Default mock returns true; flip to false for this single call only.
      mockIsFeatureEnabled.mockImplementationOnce(
        (key: { name?: string } | string) => {
          const keyName = typeof key === "string" ? key : key.name;
          return keyName !== "codexOauthProvider";
        },
      );
      const response = await pasteAuthJson(makeAuthJson());
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
