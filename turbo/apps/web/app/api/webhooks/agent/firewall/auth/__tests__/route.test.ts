import { describe, it, expect, beforeEach, vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  insertTestConnectorSecret,
  findTestConnectorTokenExpiresAt,
  findTestConnectorSecret,
  findTestModelProviderTokenState,
  setTestModelProviderTokenExpiresAt,
  insertUserMultiAuthModelProvider,
  ORG_SENTINEL_USER_ID,
  insertOrgMembersEntry,
  setOrgCredits,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../../src/mocks/server";
import { encryptSecretsMap } from "../../../../../../../src/lib/shared/crypto/secrets-encryption";
import { insertTestUserModelProviderSecret } from "../../../../../../../src/__tests__/db-test-seeders/secrets";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

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
    testToken = await generateSandboxToken(user.userId, testRunId, user.orgId);

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
      expect(data.resolvedSecrets).toEqual(["GITHUB_TOKEN"]);
      expect(data.refreshedConnectors).toEqual([]);
      expect(data.refreshedSecrets).toEqual([]);
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
      expect(data.resolvedSecrets).toEqual(["API_KEY", "API_SECRET"]);
    });

    it("should return 424 when referenced secret is missing", async () => {
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

      expect(response.status).toBe(424);
      const data = await response.json();
      expect(data.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
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
      expect(data.resolvedSecrets).toEqual([]);
    });
  });

  describe("Query parameter resolution", () => {
    it("should resolve authQuery templates with decrypted secrets", async () => {
      const encrypted = encryptTestSecrets({
        SERPAPI_TOKEN: "test-api-key-123",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {},
            authQuery: {
              api_key: "${{ secrets.SERPAPI_TOKEN }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.query).toEqual({ api_key: "test-api-key-123" });
      expect(data.headers).toEqual({});
      expect(data.resolvedSecrets).toEqual(["SERPAPI_TOKEN"]);
    });

    it("should resolve authQuery with vars", async () => {
      const encrypted = encryptTestSecrets({ KEY: "unused" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {},
            authQuery: {
              workspace: "${{ vars.WORKSPACE_ID }}",
            },
            vars: { WORKSPACE_ID: "ws-42" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.query).toEqual({ workspace: "ws-42" });
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should resolve both headers and query simultaneously", async () => {
      const encrypted = encryptTestSecrets({
        API_TOKEN: "bearer-token",
        QUERY_KEY: "query-secret",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.API_TOKEN }}",
            },
            authQuery: {
              key: "${{ secrets.QUERY_KEY }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers).toEqual({ Authorization: "Bearer bearer-token" });
      expect(data.query).toEqual({ key: "query-secret" });
      expect(data.resolvedSecrets).toEqual(["API_TOKEN", "QUERY_KEY"]);
    });

    it("should omit query field when authQuery is not provided", async () => {
      const encrypted = encryptTestSecrets({ TOKEN: "value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.TOKEN }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers).toEqual({ Authorization: "Bearer value" });
      expect(data.query).toBeUndefined();
    });
  });

  describe("Vars resolution", () => {
    it("should resolve ${{ vars.X }} templates", async () => {
      const encrypted = encryptTestSecrets({ TOKEN: "secret-value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              "X-User-Email": "${{ vars.USER_EMAIL }}",
            },
            vars: { USER_EMAIL: "user@example.com" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers["X-User-Email"]).toBe("user@example.com");
      // Vars should NOT appear in resolvedSecrets
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should resolve mixed secrets and vars in the same header", async () => {
      const encrypted = encryptTestSecrets({ API_TOKEN: "my-token" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization:
                "Basic ${{ vars.USERNAME }}:${{ secrets.API_TOKEN }}",
            },
            vars: { USERNAME: "admin" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Basic admin:my-token");
      expect(data.resolvedSecrets).toEqual(["API_TOKEN"]);
    });

    it("should return 424 when referenced var is missing", async () => {
      const encrypted = encryptTestSecrets({ TOKEN: "value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              "X-Missing": "${{ vars.NONEXISTENT }}",
            },
            vars: {},
          },
          testToken,
        ),
      );

      expect(response.status).toBe(424);
      const data = await response.json();
      expect(data.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    });

    it("should work without vars field (backward compatible)", async () => {
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
    });
  });

  describe("Billable auth expiry", () => {
    it("should bound expiresAt when billable firewall credits are available", async () => {
      await setOrgCredits(user.orgId, 10_000);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditEnabled: true,
      });

      const encrypted = encryptTestSecrets({
        API_TOKEN: "secret-token",
      });
      const before = Math.floor(Date.now() / 1000);

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.API_TOKEN }}",
            },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      const after = Math.floor(Date.now() / 1000);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer secret-token");
      expect(data.expiresAt).toBeGreaterThan(before);
      expect(data.expiresAt).toBeLessThanOrEqual(after + 30);
    });

    it("should allow billable firewall auth when member credit metadata is absent", async () => {
      await setOrgCredits(user.orgId, 10_000);

      const encrypted = encryptTestSecrets({
        API_TOKEN: "secret-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.API_TOKEN }}",
            },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer secret-token");
      expect(data.expiresAt).toBeTypeOf("number");
    });

    it("should deny billable firewall auth when credits are exhausted", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditEnabled: true,
      });

      const encrypted = encryptTestSecrets({
        API_TOKEN: "secret-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.API_TOKEN }}",
            },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });
  });

  describe("Basic auth resolution", () => {
    it("should resolve basic(secrets.USER, secrets.PASS) to Basic base64", async () => {
      const encrypted = encryptTestSecrets({
        USER: "admin",
        PASS: "secret123",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(secrets.USER, secrets.PASS) }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("admin:secret123").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["PASS", "USER"]);
    });

    it("should resolve basic with empty password", async () => {
      const encrypted = encryptTestSecrets({
        STREAK_TOKEN: "my-api-key",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(secrets.STREAK_TOKEN, ) }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("my-api-key:").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["STREAK_TOKEN"]);
    });

    it("should resolve basic with empty username", async () => {
      const encrypted = encryptTestSecrets({
        TOKEN: "pass123",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(, secrets.TOKEN) }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from(":pass123").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["TOKEN"]);
    });

    it("should resolve basic with mixed vars and secrets", async () => {
      const encrypted = encryptTestSecrets({
        API_TOKEN: "jira-token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(vars.EMAIL, secrets.API_TOKEN) }}",
            },
            vars: { EMAIL: "user@example.com" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("user@example.com:jira-token").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      // Only secrets appear in resolvedSecrets, not vars
      expect(data.resolvedSecrets).toEqual(["API_TOKEN"]);
    });

    it("should resolve basic alongside regular templates", async () => {
      const encrypted = encryptTestSecrets({
        TOKEN: "streak-key",
        OTHER: "other-val",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(secrets.TOKEN, ) }}",
              "X-Other": "${{ secrets.OTHER }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("streak-key:").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.headers["X-Other"]).toBe("other-val");
      expect(data.resolvedSecrets).toEqual(["OTHER", "TOKEN"]);
    });

    it("should return 424 when basic() references missing secret", async () => {
      const encrypted = encryptTestSecrets({
        USER: "admin",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(secrets.USER, secrets.MISSING) }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(424);
      const data = await response.json();
      expect(data.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    });

    it("should resolve basic with both args empty", async () => {
      const encrypted = encryptTestSecrets({ KEY: "unused" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(, ) }}",
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from(":").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should resolve basic with both args as vars", async () => {
      const encrypted = encryptTestSecrets({ KEY: "unused" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "${{ basic(vars.USER, vars.PASS) }}",
            },
            vars: { USER: "admin", PASS: "pw123" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("admin:pw123").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it('should resolve basic("literal", secrets.X) with literal username', async () => {
      const encrypted = encryptTestSecrets({
        GITHUB_TOKEN: "gho_real_token",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization:
                '${{ basic("x-access-token", secrets.GITHUB_TOKEN) }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("x-access-token:gho_real_token").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["GITHUB_TOKEN"]);
    });

    it('should resolve basic(secrets.X, "literal") with literal password', async () => {
      const encrypted = encryptTestSecrets({ USER: "alice" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic(secrets.USER, "fixed-pass") }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("alice:fixed-pass").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["USER"]);
    });

    it('should resolve basic("user", "pass") with both literals', async () => {
      const encrypted = encryptTestSecrets({ UNUSED: "x" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic("admin", "hunter2") }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should resolve empty literals", async () => {
      const encrypted = encryptTestSecrets({ UNUSED: "x" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic("", "") }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from(":").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should resolve basic(vars.X, literal) without tracking vars as secrets", async () => {
      const encrypted = encryptTestSecrets({ UNUSED: "x" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic(vars.USER, "pw") }}',
            },
            vars: { USER: "alice" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("alice:pw").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should not interpolate template syntax inside basic() literals", async () => {
      const encrypted = encryptTestSecrets({ FOO: "secret-value", TOKEN: "t" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization:
                '${{ basic("${{ secrets.FOO }}", secrets.TOKEN) }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      // Literal should stay as "${{ secrets.FOO }}" — not replaced with "secret-value"
      const expected = `Basic ${Buffer.from("${{ secrets.FOO }}:t").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["TOKEN"]);
    });

    it("should not treat literal content looking like secrets.X as a reference", async () => {
      // Regression: a literal whose content happens to match "secrets.FAKE"
      // must NOT be extracted as a referenced secret or resolved against
      // encryptedSecrets. Only secrets.REAL (actual reference) is resolved.
      const encrypted = encryptTestSecrets({ REAL: "real-value" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic("secrets.FAKE", secrets.REAL) }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("secrets.FAKE:real-value").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
      expect(data.resolvedSecrets).toEqual(["REAL"]);
    });

    it("should leave malformed basic() templates unchanged", async () => {
      // Literal regex forbids embedded " — the template fails to match and
      // passes through to the header as plain text rather than producing
      // an ambiguous partial replacement.
      const encrypted = encryptTestSecrets({ X: "x" });
      const malformed = '${{ basic("oops"quoted", secrets.X) }}';

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: malformed,
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe(malformed);
      expect(data.resolvedSecrets).toEqual([]);
    });

    it("should handle mixed simple and basic templates in one header", async () => {
      // Pass order: basic() resolves first, then ${{ secrets.X }} / ${{ vars.X }}.
      // Both patterns in the same header must both resolve correctly.
      const encrypted = encryptTestSecrets({ A: "aaa", B: "bbb" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              "X-Combo":
                'prefix ${{ secrets.A }} middle ${{ basic("u", secrets.B) }} suffix',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const basicPart = `Basic ${Buffer.from("u:bbb").toString("base64")}`;
      expect(data.headers["X-Combo"]).toBe(
        `prefix aaa middle ${basicPart} suffix`,
      );
      expect(data.resolvedSecrets.sort()).toEqual(["A", "B"]);
    });

    it("should preserve special characters in basic() literals", async () => {
      // Basic Auth username can legitimately contain @, :, space, $.
      const encrypted = encryptTestSecrets({ T: "token" });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: '${{ basic("user@example.com", secrets.T) }}',
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const expected = `Basic ${Buffer.from("user@example.com:token").toString("base64")}`;
      expect(data.headers.Authorization).toBe(expected);
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
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "fresh-notion-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        }),
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
      expect(data.resolvedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
      // expiresAt should be close to now + 3600 (from provider's expires_in)
      expect(data.expiresAt).toBeTypeOf("number");
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(data.expiresAt).toBeGreaterThan(nowEpoch + 3500);
      expect(data.expiresAt).toBeLessThanOrEqual(nowEpoch + 3600);
    });

    it("should use OAuth token expiry when it is earlier than billable credit lease", async () => {
      await setOrgCredits(user.orgId, 10_000);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditEnabled: true,
      });
      await setupNotionConnector({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "short-lived-notion-token",
            expires_in: 10,
          });
        }),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });
      const before = Math.floor(Date.now() / 1000);

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      const after = Math.floor(Date.now() / 1000);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe(
        "Bearer short-lived-notion-token",
      );
      expect(data.expiresAt).toBeGreaterThan(before);
      expect(data.expiresAt).toBeLessThanOrEqual(after + 10);
    });

    it("should use billable credit lease when it is earlier than OAuth token expiry", async () => {
      await setOrgCredits(user.orgId, 10_000);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditEnabled: true,
      });
      await setupNotionConnector({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "long-lived-notion-token",
            expires_in: 3600,
          });
        }),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-notion-token",
        NOTION_REFRESH_TOKEN: "notion-refresh-token",
      });
      const before = Math.floor(Date.now() / 1000);

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.NOTION_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { NOTION_ACCESS_TOKEN: "notion" },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      const after = Math.floor(Date.now() / 1000);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer long-lived-notion-token");
      expect(data.expiresAt).toBeGreaterThan(before);
      expect(data.expiresAt).toBeLessThanOrEqual(after + 30);
    });

    it("should proactively refresh token expiring within 60s buffer", async () => {
      // Token expires in 30 seconds — within the 60s buffer
      const expiresIn30s = new Date(Date.now() + 30 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiresIn30s });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "proactive-fresh-token",
            expires_in: 3600,
          });
        }),
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
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
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
      expect(data.refreshedConnectors).toEqual([]);
      expect(data.refreshedSecrets).toEqual([]);
      // expiresAt should match the stored value
      const expectedExpiry = Math.floor(validExpiry.getTime() / 1000);
      expect(data.expiresAt).toBe(expectedExpiry);
    });

    it("should refresh and backfill tokenExpiresAt when stored expiry is null", async () => {
      // Regression for #9836: historical rows with tokenExpiresAt = null must
      // self-heal on next firewall call, not be treated as non-expiring.
      await setupNotionConnector({
        tokenExpiresAt: null,
        accessToken: "stale-notion-token",
      });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "backfilled-notion-token",
            expires_in: 3600,
          });
        }),
      );

      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "stale-notion-token",
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
      expect(data.headers.Authorization).toBe("Bearer backfilled-notion-token");
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
      expect(data.expiresAt).toBeTypeOf("number");
      // Verify the null was backfilled in DB
      const tokenExpiresAt = await findTestConnectorTokenExpiresAt(
        user.orgId,
        "notion",
      );
      expect(tokenExpiresAt).not.toBeNull();
    });

    it("should refresh when forceRefresh=true even if DB expiry is in the future", async () => {
      // Regression for #9860: provider silently invalidates a token (user
      // revoked, admin rotated) while DB tokenExpiresAt is still in the
      // future. Mitm observes 401 and sets forceRefresh on the next fetch;
      // the webhook must bypass the DB-expiry check and refresh regardless.
      const futureExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: futureExpiry });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "force-refreshed-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        }),
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
            forceRefresh: true,
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer force-refreshed-token");
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
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
      expect(data.resolvedSecrets).toEqual(["GITHUB_TOKEN"]);
      expect(data.refreshedConnectors).toEqual([]);
      expect(data.refreshedSecrets).toEqual([]);
      expect(data.expiresAt).toBeNull();
    });

    it("should update tokenExpiresAt in DB after refresh", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "refreshed-token",
            refresh_token: "new-refresh",
            expires_in: 1800,
          });
        }),
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
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "fresh-mapped-token",
            expires_in: 3600,
          });
        }),
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
      expect(data.resolvedSecrets).toEqual(["NOTION_TOKEN"]);
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_TOKEN"]);
      expect(data.expiresAt).toBeTypeOf("number");
    });

    it("should return 502 when token refresh fails", async () => {
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({ tokenExpiresAt: expiredAt });

      // Provider returns error (e.g. refresh token revoked)
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }),
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
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "fresh-notion-token",
            expires_in: 3600,
          });
        }),
        mswHttp.post(CLOSE_TOKEN_URL, () => {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }),
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

    it("should use DB refresh token instead of stale encrypted refresh token", async () => {
      // Simulate: token is expired and needs refresh, but the refresh token
      // in encryptedSecrets is stale (rotated by a concurrent request).
      // DB has the current refresh token. The endpoint must use the DB value.
      const expiredAt = new Date(Date.now() - 60 * 1000);
      await setupNotionConnector({
        tokenExpiresAt: expiredAt,
        refreshToken: "current-db-refresh-token",
      });

      // Track which refresh token the provider receives
      let receivedRefreshToken: string | undefined;
      server.use(
        mswHttp.post(NOTION_TOKEN_URL, async ({ request }) => {
          const body = await request.json();
          receivedRefreshToken =
            (body as Record<string, string>).grant_type === "refresh_token"
              ? (body as Record<string, string>).refresh_token
              : undefined;
          return HttpResponse.json({
            access_token: "new-access-token",
            expires_in: 3600,
          });
        }),
      );

      // encryptedSecrets has a STALE refresh token
      const encrypted = encryptTestSecrets({
        NOTION_ACCESS_TOKEN: "old-access-token",
        NOTION_REFRESH_TOKEN: "stale-encrypted-refresh-token",
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
      expect(data.headers.Authorization).toBe("Bearer new-access-token");
      // Must have used the DB refresh token, not the stale encrypted one
      expect(receivedRefreshToken).toBe("current-db-refresh-token");
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
      expect(data.refreshedConnectors).toEqual([]);
      expect(data.refreshedSecrets).toEqual([]);
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
        mswHttp.post(NOTION_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "fresh-notion-token",
            expires_in: 3600,
          });
        }),
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
      expect(data.refreshedConnectors).toEqual(["notion"]);
      expect(data.refreshedSecrets).toEqual(["NOTION_ACCESS_TOKEN"]);
      expect(data.resolvedSecrets).toEqual([
        "GITHUB_ACCESS_TOKEN",
        "NOTION_ACCESS_TOKEN",
      ]);
    });
  });

  describe("Token refresh — codex-oauth-token model provider (#11908)", () => {
    const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";

    async function setupChatgptProvider(opts: {
      tokenExpiresAt: Date | null;
      accessToken?: string;
      refreshToken?: string;
    }): Promise<{ accessToken: string; refreshToken: string }> {
      const accessToken = opts.accessToken ?? "old-chatgpt-at";
      const refreshToken = opts.refreshToken ?? "chatgpt-rt";

      const { insertOrgMultiAuthModelProvider } =
        await import("../../../../../../../src/__tests__/db-test-seeders/org");
      const { insertTestOrgModelProviderSecret } =
        await import("../../../../../../../src/__tests__/db-test-seeders/secrets");

      await insertOrgMultiAuthModelProvider(
        user.orgId,
        "codex-oauth-token",
        "oauth",
      );
      await setTestModelProviderTokenExpiresAt(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
        opts.tokenExpiresAt,
      );

      for (const [name, value] of [
        ["CHATGPT_ACCESS_TOKEN", accessToken],
        ["CHATGPT_REFRESH_TOKEN", refreshToken],
        ["CHATGPT_ACCOUNT_ID", "ws_acc_123"],
        ["CHATGPT_ID_TOKEN", "id-tok"],
      ] as const) {
        await insertTestOrgModelProviderSecret({
          orgId: user.orgId,
          name,
          value,
        });
      }

      return { accessToken, refreshToken };
    }

    async function setupPersonalChatgptProvider(opts: {
      tokenExpiresAt: Date | null;
      accessToken?: string;
      refreshToken?: string;
    }): Promise<{ accessToken: string; refreshToken: string }> {
      const accessToken = opts.accessToken ?? "old-personal-chatgpt-at";
      const refreshToken = opts.refreshToken ?? "personal-chatgpt-rt";

      await insertUserMultiAuthModelProvider(
        user.orgId,
        user.userId,
        "codex-oauth-token",
        "oauth",
      );
      await setTestModelProviderTokenExpiresAt(
        user.orgId,
        user.userId,
        "codex-oauth-token",
        opts.tokenExpiresAt,
      );

      for (const [name, value] of [
        ["CHATGPT_ACCESS_TOKEN", accessToken],
        ["CHATGPT_REFRESH_TOKEN", refreshToken],
        ["CHATGPT_ACCOUNT_ID", "ws_acc_personal"],
        ["CHATGPT_ID_TOKEN", "id-tok-personal"],
      ] as const) {
        await insertTestUserModelProviderSecret({
          orgId: user.orgId,
          userId: user.userId,
          name,
          value,
        });
      }

      return { accessToken, refreshToken };
    }

    async function readChatgptRefreshTokenSecret(): Promise<string | null> {
      return (
        (await findTestConnectorSecret(
          user.orgId,
          "CHATGPT_REFRESH_TOKEN",
          "model-provider",
          ORG_SENTINEL_USER_ID,
        )) ?? null
      );
    }

    async function readPersonalChatgptRefreshTokenSecret(): Promise<
      string | null
    > {
      return (
        (await findTestConnectorSecret(
          user.orgId,
          "CHATGPT_REFRESH_TOKEN",
          "model-provider",
          user.userId,
        )) ?? null
      );
    }

    it("refreshes expired CHATGPT_ACCESS_TOKEN and rotates refresh_token", async () => {
      await setupChatgptProvider({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });

      server.use(
        mswHttp.post(CHATGPT_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "fresh-chatgpt-at",
            refresh_token: "rotated-chatgpt-rt",
            expires_in: 600000,
          });
        }),
      );

      const encrypted = encryptTestSecrets({
        CHATGPT_ACCESS_TOKEN: "old-chatgpt-at",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer fresh-chatgpt-at");
      expect(data.refreshedConnectors).toEqual(["codex-oauth-token"]);

      // Rotated refresh_token persisted under type='model-provider'
      const persistedRefresh = await readChatgptRefreshTokenSecret();
      expect(persistedRefresh).toBe("rotated-chatgpt-rt");

      // Metadata row updated: token_expires_at set, needs_reconnect cleared,
      // last_refresh_error_code cleared
      const row = await findTestModelProviderTokenState(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(row).not.toBeNull();
      expect(row!.tokenExpiresAt).toBeInstanceOf(Date);
      const expiryEpoch = Math.floor(
        (row!.tokenExpiresAt as Date).getTime() / 1000,
      );
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(expiryEpoch).toBeGreaterThan(nowEpoch + 599_900);
      expect(row!.needsReconnect).toBe(false);
      expect(row!.lastRefreshErrorCode).toBeNull();
    });

    it("refreshes personal codex-oauth-token using the user-tier refresh token", async () => {
      await setupChatgptProvider({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
        accessToken: "old-org-chatgpt-at",
        refreshToken: "org-chatgpt-rt",
      });
      await setupPersonalChatgptProvider({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
        accessToken: "old-personal-chatgpt-at",
        refreshToken: "personal-chatgpt-rt",
      });

      let upstreamRefreshToken: string | null = null;
      server.use(
        mswHttp.post(CHATGPT_TOKEN_URL, async ({ request }) => {
          const body = (await request.json()) as { refresh_token?: string };
          upstreamRefreshToken = body.refresh_token ?? null;
          return HttpResponse.json({
            access_token: "fresh-personal-chatgpt-at",
            refresh_token: "rotated-personal-chatgpt-rt",
            expires_in: 600000,
          });
        }),
      );

      const encrypted = encryptTestSecrets({
        CHATGPT_ACCESS_TOKEN: "old-personal-chatgpt-at",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
            secretConnectorMetadataMap: {
              CHATGPT_ACCESS_TOKEN: {
                sourceType: "model-provider",
                sourceUserId: user.userId,
                metadataKey: "codex-oauth-token",
              },
            },
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe(
        "Bearer fresh-personal-chatgpt-at",
      );
      expect(upstreamRefreshToken).toBe("personal-chatgpt-rt");
      expect(await readChatgptRefreshTokenSecret()).toBe("org-chatgpt-rt");
      expect(await readPersonalChatgptRefreshTokenSecret()).toBe(
        "rotated-personal-chatgpt-rt",
      );

      const row = await findTestModelProviderTokenState(
        user.orgId,
        user.userId,
        "codex-oauth-token",
      );
      expect(row).not.toBeNull();
      expect(row!.needsReconnect).toBe(false);
      expect(row!.lastRefreshErrorCode).toBeNull();
    });

    it("rejects forged personal codex-oauth-token owner metadata before billable credit auth", async () => {
      const encrypted = encryptTestSecrets({
        CHATGPT_ACCESS_TOKEN: "old-personal-chatgpt-at",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
            secretConnectorMetadataMap: {
              CHATGPT_ACCESS_TOKEN: {
                sourceType: "model-provider",
                sourceUserId: "other-user-id",
                metadataKey: "codex-oauth-token",
              },
            },
            firewallBillable: true,
          },
          testToken,
        ),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("classifies refresh_token_expired and persists last_refresh_error_code", async () => {
      await setupChatgptProvider({
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });

      server.use(
        mswHttp.post(CHATGPT_TOKEN_URL, () => {
          return HttpResponse.json(
            {
              error: {
                code: "refresh_token_expired",
                message: "Refresh token has expired",
              },
            },
            { status: 401 },
          );
        }),
      );

      const encrypted = encryptTestSecrets({
        CHATGPT_ACCESS_TOKEN: "old-chatgpt-at",
      });

      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            },
            secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
          },
          testToken,
        ),
      );

      // Refresh failure surfaces as 502 with TOKEN_REFRESH_FAILED so the
      // mitm addon can render a clear error to the user instead of silently
      // using a stale token.
      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error.code).toBe("TOKEN_REFRESH_FAILED");
      expect(data.error.connectors).toEqual(["codex-oauth-token"]);

      // Metadata row marked stale with the typed code
      const row = await findTestModelProviderTokenState(
        user.orgId,
        ORG_SENTINEL_USER_ID,
        "codex-oauth-token",
      );
      expect(row).not.toBeNull();
      expect(row!.needsReconnect).toBe(true);
      expect(row!.lastRefreshErrorCode).toBe("refresh_token_expired");
    });

    it("non-OAuth providers (no refreshToken on handler) do not enter refresh map", async () => {
      // openai-api-key has no refreshToken on its handler — secretConnectorMap
      // is built upstream by resolveModelProviderSecrets and excludes it.
      // This test verifies the webhook short-circuits cleanly when an entry
      // somehow makes it through (defense in depth).
      const encrypted = encryptTestSecrets({
        OPENAI_TOKEN: "sk-fake",
      });
      const response = await POST(
        makeRequest(
          {
            encryptedSecrets: encrypted,
            authHeaders: {
              Authorization: "Bearer ${{ secrets.OPENAI_TOKEN }}",
            },
            // No secretConnectorMap entry for OPENAI_TOKEN — refresh skipped
            secretConnectorMap: {},
          },
          testToken,
        ),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.refreshedConnectors).toEqual([]);
      expect(data.headers.Authorization).toBe("Bearer sk-fake");
    });
  });
});
