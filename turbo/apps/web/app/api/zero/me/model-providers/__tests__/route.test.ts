import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET, POST } from "../route";
import { DELETE } from "../[type]/route";
import { POST as setDefaultPOST } from "../[type]/default/route";
import { PATCH as updateModelPATCH } from "../[type]/model/route";
import {
  createTestRequest,
  createTestOrgModelProvider,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  insertOrgCacheEntry,
  ensureOrgRow,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

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

const BASE_URL = "http://localhost:3000/api/zero/me/model-providers";

function listUrl(): string {
  return BASE_URL;
}

function upsertUrl(): string {
  return BASE_URL;
}

function deleteUrl(type: string): string {
  return `${BASE_URL}/${type}`;
}

function setDefaultUrl(type: string): string {
  return `${BASE_URL}/${type}/default`;
}

function updateModelUrl(type: string): string {
  return `${BASE_URL}/${type}/model`;
}

interface ProviderRow {
  id: string;
  type: string;
  framework: string;
  secretName: string;
  authMethod: string | null;
  secretNames: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
}

async function listProviders(): Promise<ProviderRow[]> {
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

describe("Personal-tier (BYOK) model provider routes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    void user;
    mockIsFeatureEnabled.mockImplementation(() => {
      return true;
    });
  });

  // ---------------------------------------------------------------------------
  // Feature switch gate — all endpoints return 404 when off
  // ---------------------------------------------------------------------------

  describe("feature switch off → all endpoints 404", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return (
          key !== FeatureSwitchKey.PersonalModelProvider &&
          key !== FeatureSwitchKey.ModelFirstModelProvider
        );
      });
    });

    it("GET returns 404 when personal and model-first providers are off", async () => {
      const response = await GET(createTestRequest(listUrl()));
      expect(response.status).toBe(404);
    });

    it("POST upsert returns 404 when personal and model-first providers are off", async () => {
      const response = await createProvider("anthropic-api-key", "k");
      expect(response.status).toBe(404);
    });

    it("DELETE returns 404 when personal and model-first providers are off", async () => {
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(404);
    });

    it("POST setDefault returns 404 when personal and model-first providers are off", async () => {
      const request = createTestRequest(setDefaultUrl("anthropic-api-key"), {
        method: "POST",
      });
      const response = await setDefaultPOST(request);
      expect(response.status).toBe(404);
    });

    it("PATCH updateModel returns 404 when personal and model-first providers are off", async () => {
      const request = createTestRequest(updateModelUrl("openai-api-key"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "gpt-5" }),
      });
      const response = await updateModelPATCH(request);
      expect(response.status).toBe(404);
    });
  });

  it("allows OAuth personal providers when model-first is on", async () => {
    mockIsFeatureEnabled.mockImplementation((key) => {
      return key === FeatureSwitchKey.ModelFirstModelProvider;
    });

    const listResponse = await GET(createTestRequest(listUrl()));
    expect(listResponse.status).toBe(200);

    const oauthResponse = await createProvider(
      "claude-code-oauth-token",
      "sk-ant-test",
    );
    expect(oauthResponse.status).toBe(201);

    const byokResponse = await createProvider("anthropic-api-key", "k");
    expect(byokResponse.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // GET /api/zero/me/model-providers (list)
  // ---------------------------------------------------------------------------

  describe("GET /api/zero/me/model-providers", () => {
    it("returns empty list when no personal providers exist", async () => {
      const response = await GET(createTestRequest(listUrl()));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.modelProviders).toEqual([]);
    });

    it("lists only the user's personal providers, not the org's", async () => {
      // Seed an org-tier provider in the same org
      await createTestOrgModelProvider("anthropic-api-key", "org-key");
      // Create a personal provider for the authenticated user
      await createProvider("openai-api-key", "user-key", "gpt-5.5");

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("openai-api-key");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/me/model-providers (upsert)
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/me/model-providers", () => {
    it("creates a single-secret personal provider", async () => {
      const response = await createProvider("anthropic-api-key", "sk-ant-test");
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("anthropic-api-key");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.isDefault).toBe(true);
      expect(data.created).toBe(true);
    });

    it("updates an existing personal provider with 200", async () => {
      await createProvider("anthropic-api-key", "first");
      const response = await createProvider("anthropic-api-key", "second");
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.created).toBe(false);
    });

    it("creates a multi-auth personal provider (aws-bedrock access-keys)", async () => {
      const response = await createMultiAuthProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "akid",
          AWS_SECRET_ACCESS_KEY: "secret",
          AWS_REGION: "us-east-1",
        },
      );
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("aws-bedrock");
      expect(data.provider.authMethod).toBe("access-keys");
      expect(data.provider.secretNames).toContain("AWS_ACCESS_KEY_ID");
    });

    it("returns 400 when single-secret provider is missing the secret", async () => {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "anthropic-api-key" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // vm0 rejection — vm0 is org-only per Epic #11868 (migrated from service test)
  // ---------------------------------------------------------------------------

  describe("vm0 rejection on personal-tier upsert", () => {
    it("returns 400 when posting vm0 with a secret (service-layer rejects)", async () => {
      const response = await createProvider("vm0", "any-value");
      expect(response.status).toBe(400);
    });

    it("returns 400 when posting vm0 with no secret (route-level missing-secret check)", async () => {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "vm0" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // CodexBeta carryover for openai-api-key
  // ---------------------------------------------------------------------------

  describe("openai-api-key codex-beta gate", () => {
    it("creates openai-api-key when codex-beta is enabled", async () => {
      mockIsFeatureEnabled.mockImplementation(() => {
        return true;
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

    it("returns 404 when codex-beta is disabled (personalModelProvider on)", async () => {
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

    it("does not gate non-codex types when codex-beta is disabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.CodexBeta;
      });
      const response = await createProvider("anthropic-api-key", "sk-ant-test");
      expect(response.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/zero/me/model-providers/:type
  // ---------------------------------------------------------------------------

  describe("DELETE /api/zero/me/model-providers/:type", () => {
    it("deletes the user's personal provider", async () => {
      await createProvider("anthropic-api-key", "k");
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(204);

      const providers = await listProviders();
      expect(providers).toHaveLength(0);
    });

    it("returns 404 when deleting a non-existent personal provider", async () => {
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/me/model-providers/:type/default
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/me/model-providers/:type/default", () => {
    it("flips the user's personal default", async () => {
      await createProvider("anthropic-api-key", "ant");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const request = createTestRequest(setDefaultUrl("openai-api-key"), {
        method: "POST",
      });
      const response = await setDefaultPOST(request);
      expect(response.status).toBe(200);

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const openai = providers.find((p) => {
        return p.type === "openai-api-key";
      });
      expect(anthropic?.isDefault).toBe(false);
      expect(openai?.isDefault).toBe(true);
    });

    it("returns 404 when type does not exist for the user", async () => {
      const request = createTestRequest(setDefaultUrl("anthropic-api-key"), {
        method: "POST",
      });
      const response = await setDefaultPOST(request);
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/zero/me/model-providers/:type/model
  // ---------------------------------------------------------------------------

  describe("PATCH /api/zero/me/model-providers/:type/model", () => {
    it("updates only selectedModel", async () => {
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5");

      const request = createTestRequest(updateModelUrl("openai-api-key"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "gpt-5.5" }),
      });
      const response = await updateModelPATCH(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.selectedModel).toBe("gpt-5.5");
      expect(data.type).toBe("openai-api-key");
    });

    it("returns 404 when the personal provider does not exist", async () => {
      const request = createTestRequest(updateModelUrl("openai-api-key"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedModel: "gpt-5.5" }),
      });
      const response = await updateModelPATCH(request);
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // codex-oauth-token auth_json paste flow (#12024) — mirrors the org-side
  // suite in app/api/zero/model-providers/__tests__/route.test.ts.
  // ---------------------------------------------------------------------------

  describe("codex-oauth-token auth_json paste flow (personal scope)", () => {
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
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    function makeAuthJson(overrides?: { planType?: string }): string {
      const accessExp = Math.floor(Date.now() / 1000) + 7200;
      return JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: makeJwt({ exp: accessExp }),
          refresh_token: "rt_personal_synthetic_high_entropy",
          account_id: "ws_acct_plain",
          id_token: makeIdToken({
            accountId: "ws_acct_from_id_token_personal",
            planType: overrides?.planType ?? "plus",
            workspaceName: "Personal Acme",
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

    it("happy path: paste valid auth.json persists derived secrets + metadata", async () => {
      const response = await pasteAuthJson(makeAuthJson());
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("codex-oauth-token");
      expect(data.provider.authMethod).toBe("auth_json");
      expect(data.provider.workspaceName).toBe("Personal Acme");
      expect(data.provider.planType).toBe("plus");
      expect(data.provider.needsReconnect).toBe(false);
    });

    it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID on malformed JSON", async () => {
      const response = await pasteAuthJson("{ not json");
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    });

    it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID when tokens.refresh_token missing", async () => {
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

    it("returns 404 when CodexOauthProvider feature switch is off", async () => {
      mockIsFeatureEnabled.mockImplementation((key: FeatureSwitchKey) => {
        // PersonalModelProvider stays on; only CodexOauthProvider gates this branch
        return key !== FeatureSwitchKey.CodexOauthProvider;
      });
      const response = await pasteAuthJson(makeAuthJson());
      expect(response.status).toBe(404);
    });
  });
});

// ===========================================================================
// Cross-user privacy invariant — migrated from model-provider-service.test.ts
//
// Epic #11868 Decision 1: a user's personal provider id must not be visible
// to another user in the same org. Verified end-to-end through the route.
// ===========================================================================

describe("Personal-tier routes — cross-user privacy invariant", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockImplementation(() => {
      return true;
    });
  });

  async function setupTwoUserOrg(): Promise<{
    orgId: string;
    alice: string;
    bob: string;
  }> {
    const suffix = uniqueId("two-user");
    const orgId = `org_${suffix}`;
    const alice = `user_alice_${suffix}`;
    const bob = `user_bob_${suffix}`;
    await insertOrgCacheEntry({ orgId, slug: `org-${suffix}` });
    await ensureOrgRow(orgId);
    return { orgId, alice, bob };
  }

  function authAs(userId: string, orgId: string): void {
    mockClerk({ userId, orgId });
  }

  it("alice's GET only returns alice's providers (not bob's)", async () => {
    const { orgId, alice, bob } = await setupTwoUserOrg();

    authAs(alice, orgId);
    await createProvider("openai-api-key", "alice-key", "gpt-5");

    authAs(bob, orgId);
    await createProvider("anthropic-api-key", "bob-key");

    authAs(alice, orgId);
    const aliceList = await listProviders();
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]?.type).toBe("openai-api-key");

    authAs(bob, orgId);
    const bobList = await listProviders();
    expect(bobList).toHaveLength(1);
    expect(bobList[0]?.type).toBe("anthropic-api-key");
  });

  it("bob cannot delete a type alice owns (404, no row of that type for bob)", async () => {
    const { orgId, alice, bob } = await setupTwoUserOrg();

    authAs(alice, orgId);
    await createProvider("openai-api-key", "alice-key", "gpt-5");

    authAs(bob, orgId);
    const request = createTestRequest(deleteUrl("openai-api-key"), {
      method: "DELETE",
    });
    const response = await DELETE(request);
    expect(response.status).toBe(404);

    // Alice's provider remains intact
    authAs(alice, orgId);
    const aliceList = await listProviders();
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]?.type).toBe("openai-api-key");
  });

  it("bob cannot setDefault on a type alice owns (404)", async () => {
    const { orgId, alice, bob } = await setupTwoUserOrg();

    authAs(alice, orgId);
    await createProvider("openai-api-key", "alice-key", "gpt-5");

    authAs(bob, orgId);
    const request = createTestRequest(setDefaultUrl("openai-api-key"), {
      method: "POST",
    });
    const response = await setDefaultPOST(request);
    expect(response.status).toBe(404);
  });

  it("bob cannot updateModel on a type alice owns (404)", async () => {
    const { orgId, alice, bob } = await setupTwoUserOrg();

    authAs(alice, orgId);
    await createProvider("openai-api-key", "alice-key", "gpt-5");

    authAs(bob, orgId);
    const request = createTestRequest(updateModelUrl("openai-api-key"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedModel: "gpt-5.5" }),
    });
    const response = await updateModelPATCH(request);
    expect(response.status).toBe(404);
  });
});
