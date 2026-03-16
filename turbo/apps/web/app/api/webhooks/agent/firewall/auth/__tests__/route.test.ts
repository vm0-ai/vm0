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
      await setupNotionConnector({ tokenExpiresAt: validExpiry });

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
      await setupNotionConnector({ tokenExpiresAt: null });

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

    it("should use existing token when refresh fails", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // Provider returns error
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

      expect(response.status).toBe(200);
      const data = await response.json();
      // Falls back to old token
      expect(data.headers.Authorization).toBe("Bearer old-notion-token");
      // expiresAt is the original expired value (not cached for long by addon)
      const expiredEpoch = Math.floor(expiredAt.getTime() / 1000);
      expect(data.expiresAt).toBe(expiredEpoch);
    });
  });
});
