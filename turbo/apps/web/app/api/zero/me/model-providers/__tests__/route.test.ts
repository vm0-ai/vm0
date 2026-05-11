import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET, POST } from "../route";
import { DELETE } from "../[type]/route";
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

async function expectUnauthorized(
  responsePromise: Promise<Response> | Response,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(401);
  const data = await response.json();
  expect(data.error.code).toBe("UNAUTHORIZED");
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

describe("Model-first personal OAuth model provider routes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    void user;
    mockIsFeatureEnabled.mockImplementation(() => {
      return true;
    });
  });

  describe("no active organization", () => {
    beforeEach(() => {
      mockClerk({ userId: user.userId, orgId: null });
    });

    it("GET returns 401", async () => {
      await expectUnauthorized(GET(createTestRequest(listUrl())));
    });

    it("POST returns 401", async () => {
      await expectUnauthorized(createProvider("claude-code-oauth-token", "k"));
    });

    it("DELETE returns 401", async () => {
      const request = createTestRequest(deleteUrl("claude-code-oauth-token"), {
        method: "DELETE",
      });
      await expectUnauthorized(DELETE(request));
    });
  });

  // ---------------------------------------------------------------------------
  // Feature switch gate — list/upsert return 404 when off
  // ---------------------------------------------------------------------------

  describe("feature switch off → gated endpoints 404", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.ModelFirstModelProvider;
      });
    });

    it("GET returns 404 when model-first providers are off", async () => {
      const response = await GET(createTestRequest(listUrl()));
      expect(response.status).toBe(404);
    });

    it("POST upsert returns 404 when model-first providers are off", async () => {
      const response = await createProvider("claude-code-oauth-token", "k");
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
      await createProvider("claude-code-oauth-token", "user-key");

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("claude-code-oauth-token");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/me/model-providers (upsert)
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/me/model-providers", () => {
    it("creates a single-secret personal provider", async () => {
      const response = await createProvider(
        "claude-code-oauth-token",
        "sk-ant-test",
      );
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("claude-code-oauth-token");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.isDefault).toBe(true);
      expect(data.created).toBe(true);
    });

    it("updates an existing personal provider with 200", async () => {
      await createProvider("claude-code-oauth-token", "first");
      const response = await createProvider(
        "claude-code-oauth-token",
        "second",
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.created).toBe(false);
    });

    it("returns 404 for non model-first personal provider types", async () => {
      const response = await createProvider("anthropic-api-key", "sk-ant-test");
      expect(response.status).toBe(404);
    });

    it("returns 400 when single-secret provider is missing the secret", async () => {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "claude-code-oauth-token" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // vm0 rejection — vm0 is org-only
  // ---------------------------------------------------------------------------

  describe("vm0 rejection on personal-tier upsert", () => {
    it("returns 404 when posting vm0 with a secret", async () => {
      const response = await createProvider("vm0", "any-value");
      expect(response.status).toBe(404);
    });

    it("returns 404 when posting vm0 with no secret", async () => {
      const request = createTestRequest(upsertUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "vm0" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // OpenAI API key is no longer a personal-provider route
  // ---------------------------------------------------------------------------

  describe("openai-api-key rejection", () => {
    it("returns 404 for openai-api-key", async () => {
      const response = await createProvider(
        "openai-api-key",
        "sk-proj-test",
        "gpt-5.5",
      );
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/zero/me/model-providers/:type
  // ---------------------------------------------------------------------------

  describe("DELETE /api/zero/me/model-providers/:type", () => {
    it("deletes the user's personal provider", async () => {
      await createProvider("claude-code-oauth-token", "k");
      const request = createTestRequest(deleteUrl("claude-code-oauth-token"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(204);

      const providers = await listProviders();
      expect(providers).toHaveLength(0);
    });

    it("returns 404 when deleting a non-existent personal provider", async () => {
      const request = createTestRequest(deleteUrl("claude-code-oauth-token"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(404);
    });

    it("does not require personal provider feature switches", async () => {
      await createProvider("claude-code-oauth-token", "sk-ant-test");
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.ModelFirstModelProvider;
      });

      const request = createTestRequest(deleteUrl("claude-code-oauth-token"), {
        method: "DELETE",
      });
      const response = await DELETE(request);
      expect(response.status).toBe(204);
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

describe("Model-first personal OAuth routes — cross-user privacy invariant", () => {
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
    await createProvider("claude-code-oauth-token", "alice-key");

    authAs(bob, orgId);
    await createProvider("claude-code-oauth-token", "bob-key");

    authAs(alice, orgId);
    const aliceList = await listProviders();
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]?.type).toBe("claude-code-oauth-token");

    authAs(bob, orgId);
    const bobList = await listProviders();
    expect(bobList).toHaveLength(1);
    expect(bobList[0]?.type).toBe("claude-code-oauth-token");
  });

  it("bob cannot delete a type alice owns (404, no row of that type for bob)", async () => {
    const { orgId, alice, bob } = await setupTwoUserOrg();

    authAs(alice, orgId);
    await createProvider("claude-code-oauth-token", "alice-key");

    authAs(bob, orgId);
    const request = createTestRequest(deleteUrl("claude-code-oauth-token"), {
      method: "DELETE",
    });
    const response = await DELETE(request);
    expect(response.status).toBe(404);

    // Alice's provider remains intact
    authAs(alice, orgId);
    const aliceList = await listProviders();
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]?.type).toBe("claude-code-oauth-token");
  });
});
