import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  insertOrgCacheEntry,
  ensureOrgRow,
  findTestConnectorSecret,
  findTestModelProviderTokenState,
  ORG_SENTINEL_USER_ID,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";
import { insertOrgMembersCacheEntry } from "../../../../../../src/__tests__/db-test-seeders/org-members-cache";
import { setOrgCredits } from "../../../../../../src/__tests__/db-test-seeders/org";

const mockGetUserList = vi.fn();
vi.mock("@clerk/nextjs/server", () => {
  return {
    clerkClient: vi.fn(async () => {
      return {
        users: { getUserList: mockGetUserList },
      };
    }),
    auth: vi.fn(async () => {
      return { userId: null, orgId: null, orgRole: null };
    }),
  };
});

const context = testContext();

const TEST_USER_ID = "user_codex_oauth_test";
const TEST_ORG_ID = "org_codex_oauth_test";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const VALID_BODY = {
  accessToken: "REAL-AT-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718",
  refreshToken: "REAL-RT-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
  accountId: "ws_REAL_ACCOUNT_test",
  idToken: "hdr.PAYLOAD.SIG",
};

function makeRequest(body: unknown): Request {
  return createTestRequest(
    "http://localhost:3000/api/cli/auth/test-codex-oauth",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("/api/cli/auth/test-codex-oauth", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    reloadEnv();

    mockGetUserList.mockResolvedValue({ data: [{ id: TEST_USER_ID }] });

    await insertOrgCacheEntry({
      orgId: TEST_ORG_ID,
      slug: "codex-oauth-org",
    });
    await ensureOrgRow(TEST_ORG_ID);
    await insertOrgMembersCacheEntry({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      role: "admin",
      cachedAt: new Date(Date.now() + ONE_YEAR_MS),
    });
    await setOrgCredits(TEST_ORG_ID, 100_000);
  });

  it("returns 404 in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const response = await POST(makeRequest(VALID_BODY));
    expect(response.status).toBe(404);
  });

  it("rejects invalid body", async () => {
    const response = await POST(makeRequest({ accessToken: "missing-others" }));
    expect(response.status).toBe(400);
  });

  it("seeds codex-oauth-token provider with secrets and tokenExpiresAt", async () => {
    const response = await POST(makeRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.orgId).toBe(TEST_ORG_ID);
    expect(data.tokenExpiresAt).toBeTypeOf("string");

    // model_providers row exists with expected token state
    const state = await findTestModelProviderTokenState(
      TEST_ORG_ID,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state).not.toBeNull();
    expect(state!.tokenExpiresAt).toBeInstanceOf(Date);
    expect(state!.needsReconnect).toBe(false);
    expect(state!.lastRefreshErrorCode).toBeNull();

    // All four secrets persisted under type=model-provider
    const persisted = await Promise.all(
      [
        "CHATGPT_ACCESS_TOKEN",
        "CHATGPT_REFRESH_TOKEN",
        "CHATGPT_ACCOUNT_ID",
        "CHATGPT_ID_TOKEN",
      ].map((name) => {
        return findTestConnectorSecret(TEST_ORG_ID, name, "model-provider");
      }),
    );
    expect(persisted[0]).toBe(VALID_BODY.accessToken);
    expect(persisted[1]).toBe(VALID_BODY.refreshToken);
    expect(persisted[2]).toBe(VALID_BODY.accountId);
    expect(persisted[3]).toBe(VALID_BODY.idToken);
  });

  it("pre-expires token when expiresIn is negative", async () => {
    const response = await POST(makeRequest({ ...VALID_BODY, expiresIn: -60 }));
    expect(response.status).toBe(200);

    const state = await findTestModelProviderTokenState(
      TEST_ORG_ID,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state).not.toBeNull();
    expect(state!.tokenExpiresAt).toBeInstanceOf(Date);
    expect(state!.tokenExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("marks provider stale when needsReconnect=true and persists lastRefreshErrorCode", async () => {
    const response = await POST(
      makeRequest({
        ...VALID_BODY,
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      }),
    );
    expect(response.status).toBe(200);

    const state = await findTestModelProviderTokenState(
      TEST_ORG_ID,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state).not.toBeNull();
    expect(state!.needsReconnect).toBe(true);
    expect(state!.lastRefreshErrorCode).toBe("refresh_token_expired");
  });

  describe("authJson variant", () => {
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

    function makeAuthJson(): string {
      const accessExp = Math.floor(Date.now() / 1000) + 7200;
      const idToken = makeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "Acme" },
        },
        exp: accessExp,
      });
      return JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: makeJwt({ exp: accessExp }),
          refresh_token: "rt_synthetic_authjson_seed",
          account_id: "ws_acct_plain",
          id_token: idToken,
        },
      });
    }

    it("seeds codex-oauth-token via auth_json paste path", async () => {
      const response = await POST(makeRequest({ authJson: makeAuthJson() }));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.orgId).toBe(TEST_ORG_ID);

      const state = await findTestModelProviderTokenState(
        TEST_ORG_ID,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(state).not.toBeNull();
      expect(state!.tokenExpiresAt).toBeInstanceOf(Date);
      expect(state!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(state!.workspaceName).toBe("Acme");
      expect(state!.planType).toBe("plus");
      expect(state!.needsReconnect).toBe(false);
      expect(state!.lastRefreshErrorCode).toBeNull();

      // Account id sourced from id_token claim, not tokens.account_id
      const accountId = await findTestConnectorSecret(
        TEST_ORG_ID,
        "CHATGPT_ACCOUNT_ID",
        "model-provider",
      );
      expect(accountId).toBe("ws_acct_id_token");

      // Refresh token persisted; raw blob NOT persisted
      const refresh = await findTestConnectorSecret(
        TEST_ORG_ID,
        "CHATGPT_REFRESH_TOKEN",
        "model-provider",
      );
      expect(refresh).toBe("rt_synthetic_authjson_seed");
      const rawBlob = await findTestConnectorSecret(
        TEST_ORG_ID,
        "CODEX_AUTH_JSON",
        "model-provider",
      );
      expect(rawBlob).toBeUndefined();
    });

    it("rejects malformed authJson with 400", async () => {
      const response = await POST(makeRequest({ authJson: "{ not json" }));
      expect(response.status).toBe(400);
    });
  });
});
