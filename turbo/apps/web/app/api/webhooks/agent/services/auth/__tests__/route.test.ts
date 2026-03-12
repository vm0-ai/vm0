import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { encryptSecretsMap } from "../../../../../../../src/lib/crypto/secrets-encryption";

const context = testContext();

function makeRequest(body: Record<string, unknown>, token?: string): Request {
  return createTestRequest(
    "http://localhost:3000/api/webhooks/agent/services/auth",
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

describe("POST /api/webhooks/agent/services/auth", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `agent-service-auth-${Date.now()}`,
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
            authHeaders: { Authorization: "Bearer ${secrets.TOKEN}" },
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
              Authorization: "Bearer ${secrets.GITHUB_TOKEN}",
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
              "X-Api-Key": "${secrets.API_KEY}",
              "X-Api-Secret": "${secrets.API_SECRET}",
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
              Authorization: "Bearer ${secrets.UNKNOWN_KEY}",
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
});
