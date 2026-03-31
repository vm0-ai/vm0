import { describe, it, expect, beforeEach, vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  insertTestConnectorSecret,
  findTestConnectorTokenExpiresAt,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../../src/mocks/server";
import { encryptSecretsMap } from "../../../../../../../src/lib/crypto/secrets-encryption";

const context = testContext();

function makeRequest(body: Record<string, unknown>, token?: string): Request {
  return createTestRequest(
    "http://localhost:3000/api/webhooks/agent/firewall/auth",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

function encryptTestSecrets(secrets: Record<string, string>): string {
  const encrypted = encryptSecretsMap(
    secrets,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
  if (!encrypted) throw new Error("Failed to encrypt test secrets");
  return encrypted;
}

describe("POST /api/webhooks/agent/firewall/auth", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `agent-firewall-auth-${Date.now()}`,
    );
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
    testToken = await createTestSandboxToken(user.userId, testRunId);

    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject without auth header", async () => {
      const response = await POST(
        makeRequest({
          encryptedSecrets: "iv:tag:data",
          authHeaders: {},
        }),
      );
      expect(response.status).toBe(401);
    });

    it("should reject with invalid token", async () => {
      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: "iv:tag:data",
            authHeaders: {},
          },
          "invalid-token",
        ),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("Validation", () => {
    it("should reject without encryptedSecrets", async () => {
      const response = await POST(makeRequest({ authHeaders: {} }, testToken));
      expect(response.status).toBe(400);
    });

    it("should reject without authHeaders", async () => {
      const response = await POST(
        makeRequest({ encryptedSecrets: "iv:tag:data" }, testToken),
      );
      expect(response.status).toBe(400);
    });

    it("should reject invalid encrypted data", async () => {
      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: "not-valid-encrypted-data",
            authHeaders: { Authorization: "Bearer ${{ secrets.TOKEN }}" },
          },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("Template resolution", () => {
    it("should resolve auth header templates with decrypted secrets", async () => {
      const encrypted = encryptTestSecrets({
        GITHUB_TOKEN: "ghp_test_token_123",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers).toEqual({
        Authorization: "Bearer ghp_test_token_123",
      });
      expect(data.expiresIn).toBeUndefined();
    });

    it("should resolve multiple headers", async () => {
      const encrypted = encryptTestSecrets({
        API_KEY: "key-123",
        API_SECRET: "secret-456",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              "X-Api-Key": "${{ secrets.API_KEY }}",
              "X-Api-Secret": "${{ secrets.API_SECRET }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers).toEqual({
        "X-Api-Key": "key-123",
        "X-Api-Secret": "secret-456",
      });
    });

    it("should resolve unknown secret to empty string", async () => {
      const encrypted = encryptTestSecrets({ KNOWN: "value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.UNKNOWN_KEY }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer ");
    });

    it("should pass through headers without template syntax", async () => {
      const encrypted = encryptTestSecrets({ KEY: "value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: { "X-Static": "plain-value" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers["X-Static"]).toBe("plain-value");
    });
  });

  describe("Token refresh with secretConnectorMap", () => {
    const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

    async function setupNotionConnector(opts: {
      tokenExpiresAt: Date | null;
      accessToken?: string;
      refreshToken?: string;
    }) {
      const accessToken = opts.accessToken ?? "old-notion-token";
      const refreshToken = opts.refreshToken ?? "notion-refresh-token";

      // Stub Notion OAuth credentials
      vi.stubEnv("NOTION_OAUTH_CLIENT_ID", "test-notion-client-id");
      vi.stubEnv("NOTION_OAUTH_CLIENT_SECRET", "test-notion-client-secret");
      // Re-initialize env after stubbing
      const { reloadEnv } = await import("../../../../../../../src/env");
      reloadEnv();

      // Create connector record with tokenExpiresAt
      await context.createConnector(user.orgId, {
        userId: user.userId,
        type: "notion",
        authMethod: "oauth",
        tokenExpiresAt: opts.tokenExpiresAt,
      });

      // Insert access token and refresh token secrets
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "NOTION_ACCESS_TOKEN",
        accessToken,
      );
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "NOTION_REFRESH_TOKEN",
        refreshToken,
      );

      return { accessToken, refreshToken };
    }

    it("should refresh expired token and return accurate expiresAt", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000); // 1 min ago
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // MSW handler for Notion token refresh
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "fresh-notion-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Should use refreshed token in resolved header
      expect(data.headers.Authorization).toBe("Bearer fresh-notion-token");
      // expiresAt should be close to now + 3600 (from provider's expires_in)
      expect(data.expiresAt).toBeTypeOf("number");
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(data.expiresAt).toBeGreaterThan(nowEpoch + 3500);
      expect(data.expiresAt).toBeLessThanOrEqual(nowEpoch + 3600);
    });

    it("should proactively refresh token expiring within 60s buffer", async () => {
      // Token expires in 30 seconds — within the 60s buffer
      const expiresIn30s = new Date(Date.now() + 30 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiresIn30s });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "proactive-fresh-token",
            expires_in: 3600,
          }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Should have proactively refreshed
      expect(data.headers.Authorization).toBe("Bearer proactive-fresh-token");
      expect(data.expiresAt).toBeTypeOf("number");
    });

    it("should skip refresh for valid token and return its expiresAt", async () => {
      // Token valid for another 30 minutes — well outside the 60s buffer
      const validExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await setupNotionConnector({
        tokenExpiresAt: validExpiry,
        accessToken: "valid-notion-token",
      });

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "valid-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Should use the existing token (no refresh)
      expect(data.headers.Authorization).toBe("Bearer valid-notion-token");
      // expiresAt should match the stored value
      const expectedExpiry = Math.floor(validExpiry.getTime() / 1000);
      expect(data.expiresAt).toBe(expectedExpiry);
    });

    it("should return null expiresAt for non-expiring token", async () => {
      // tokenExpiresAt = null means non-expiring
      await setupNotionConnector({
        tokenExpiresAt: null,
        accessToken: "permanent-notion-token",
      });

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "permanent-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer permanent-notion-token");
      expect(data.expiresAt).toBeNull();
    });

    it("should return null expiresAt without secretConnectorMap", async () => {
      const encrypted = encryptTestSecrets({
        GITHUB_TOKEN: "ghp_test_token_123",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer ghp_test_token_123");
      expect(data.expiresAt).toBeNull();
    });

    it("should update tokenExpiresAt in DB after refresh", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "refreshed-token",
            refresh_token: "new-refresh",
            expires_in: 1800,
          }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      // Verify tokenExpiresAt was updated in the database
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "notion",
      );

      expect(tokenExpiresAt).toBeDefined();
      expect(tokenExpiresAt).not.toBeNull();
      const newExpiry = tokenExpiresAt!.getTime();
      const expectedMin = Date.now() + 1700 * 1000; // ~1800s minus small margin
      expect(newExpiry).toBeGreaterThan(expectedMin);
    });

    it("should refresh when template references mapped env var name", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "fresh-mapped-token",
            expires_in: 3600,
          }),
        ),
      );

      // Secrets contain both raw and mapped names (as build-context produces)
      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            // Template references the MAPPED env var name
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_TOKEN }}",
            },
            // secretConnectorMap includes both raw and mapped keys
            secretConnectorMap: {
              NOTION_ACCESS_TOKEN: "notion",
              NOTION_TOKEN: "notion",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // The mapped env var should have the refreshed token
      expect(data.headers.Authorization).toBe("Bearer fresh-mapped-token");
      expect(data.expiresAt).toBeTypeOf("number");
    });

    it("should return 502 when token refresh fails", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // Provider returns error (e.g. refresh token revoked)
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error.code).toBe("TOKEN_REFRESH_FAILED");
      expect(data.error.connectors).toEqual(["notion"]);
    });

    it("should return 502 when one of multiple connectors fails to refresh", async () => {
      const CLOSE_TOKEN_URL = "https://api.close.com/oauth2/token/";
      const expiredAt = new Date(Date.now() - 60 * 1000);

      // Setup Notion (will succeed)
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // Setup Close (will fail)
      vi.stubEnv("CLOSE_OAUTH_CLIENT_ID", "test-close-client-id");
      vi.stubEnv("CLOSE_OAUTH_CLIENT_SECRET", "test-close-client-secret");
      const { reloadEnv } = await import("../../../../../../../src/env");
      reloadEnv();

      await context.createConnector(user.orgId, {
        userId: user.userId,
        type: "close",
        authMethod: "oauth",
        tokenExpiresAt: expiredAt,
      });
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "CLOSE_ACCESS_TOKEN",
        "old-close-token",
      );
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "CLOSE_REFRESH_TOKEN",
        "close-refresh-token",
      );

      // Notion refresh succeeds, Close refresh fails
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "fresh-notion-token",
            expires_in: 3600,
          }),
        ),
        mswHttp.post(CLOSE_TOKEN_URL, () =>
          HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
        CLOSE_ACCESS_TOKEN: "old-close-token",
        CLOSE_REFRESH_TOKEN: "close-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
              "X-Close-Token": "Bearer ${{ secrets.CLOSE_ACCESS_TOKEN }}",
            },
            secretConnectorMap: {
              NOTION_ACCESS_TOKEN: "notion",
              CLOSE_ACCESS_TOKEN: "close",
            },
          },
          testToken,
        ),
      );

      // Should still return 502 because one connector failed
      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error.code).toBe("TOKEN_REFRESH_FAILED");
      expect(data.error.connectors).toEqual(["close"]);
    });

    it("should use current DB token when another request already refreshed", async () => {
      // Simulate race condition: token was recently refreshed by another request.
      // DB has fresh expiry (30 min) and fresh token in secrets table,
      // but encryptedSecrets still has the stale build-time token.
      const validExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await setupNotionConnector({
        tokenExpiresAt: validExpiry,
        accessToken: "fresh-db-token",
      });

      // encryptedSecrets has the STALE build-time token
      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "stale-build-time-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Must use the fresh DB token, NOT the stale encryptedSecrets token
      expect(data.headers.Authorization).toBe("Bearer fresh-db-token");
      expect(data.expiresAt).toBeTypeOf("number");
    });

    it("should sync skipped connector tokens when only some need refresh", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);

      // Notion: expired, will be refreshed via provider
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // GitHub: valid (recently refreshed by another request), DB has fresh token
      vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "test-github-client-id");
      vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "test-github-client-secret");
      const { reloadEnv } = await import("../../../../../../../src/env");
      reloadEnv();

      await context.createConnector(user.orgId, {
        userId: user.userId,
        type: "github",
        authMethod: "oauth",
        tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "GITHUB_ACCESS_TOKEN",
        "fresh-github-token",
      );
      await insertTestConnectorSecret(
        user.orgId,
        user.userId,
        "GITHUB_REFRESH_TOKEN",
        "github-refresh-token",
      );

      // MSW for Notion refresh
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () =>
          HttpResponse.json({
            access_token: "fresh-notion-token",
            expires_in: 3600,
          }),
        ),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "stale-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
        GITHUB_ACCESS_TOKEN: "stale-github-token",
        GITHUB_REFRESH_TOKEN: "github-refresh-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              "X-Notion": "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
              "X-Github": "token ${{ secrets.GITHUB_ACCESS_TOKEN }}",
            },
            secretConnectorMap: {
              NOTION_ACCESS_TOKEN: "notion",
              GITHUB_ACCESS_TOKEN: "github",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Notion: refreshed via provider
      expect(data.headers["X-Notion"]).toBe("Bearer fresh-notion-token");
      // GitHub: synced from DB (not refreshed, but DB has fresh token)
      expect(data.headers["X-Github"]).toBe("token fresh-github-token");
    });
  });
});
