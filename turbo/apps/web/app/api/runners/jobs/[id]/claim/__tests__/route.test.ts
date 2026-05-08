import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCliToken,
  createTestCompose,
  createTestRunnerJob,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { encryptSecretsMap } from "../../../../../../../src/lib/shared/crypto/secrets-encryption";
import { verifySandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

// OFFICIAL_RUNNER_SECRET is set in setup.ts
const OFFICIAL_RUNNER_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("POST /api/runners/jobs/:id/claim", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("Authentication - getRunnerAuth behavior", () => {
    const testRunId = randomUUID();

    describe("with no Authorization header", () => {
      it("should return 401", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with non-Bearer token", () => {
      it("should return 401", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Basic sometoken",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with sandbox JWT token", () => {
      it("should return 401 (sandbox tokens rejected on runner endpoints)", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer header.payload.signature",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });

    describe("with official runner token", () => {
      it("should return 401 when secret does not match", async () => {
        const wrongSecret = "wrong_secret_that_does_not_match_at_all_here";
        const token = `vm0_official_${wrongSecret}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should return 401 when secret has different length (timing-safe)", async () => {
        const shortSecret = "short";
        const token = `vm0_official_${shortSecret}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should authenticate successfully with valid secret (job not found)", async () => {
        const token = `vm0_official_${OFFICIAL_RUNNER_SECRET}`;

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        // Auth succeeds, but job not found (no job in queue)
        expect(response.status).toBe(404);
        expect(data.error.message).toContain("Job not found");
      });
    });

    describe("with CLI token", () => {
      it("should return 401 when token is not found in database", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer invalid_nonexistent_token",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });

      it("should authenticate successfully with valid token (job not found)", async () => {
        const token = await createTestCliToken(user.userId);

        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        // Auth succeeds, but job not found (no job in queue)
        expect(response.status).toBe(404);
        expect(data.error.message).toContain("Job not found");
      });
    });

    describe("with unknown token format", () => {
      it("should return 401 for random string", async () => {
        const request = createTestRequest(
          `http://localhost:3000/api/runners/jobs/${testRunId}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer random_unknown_token",
            },
            body: JSON.stringify({}),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error.message).toContain("Not authenticated");
      });
    });
  });

  describe("Claim flow - Agent metadata", () => {
    it("should return appendSystemPrompt in claim response", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-asp"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        undefined,
        { appendSystemPrompt: "Your name is Aria." },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.appendSystemPrompt).toBe("Your name is Aria.");
    });

    it("should return null appendSystemPrompt when not set", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-asp-null"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.appendSystemPrompt).toBeNull();
    });
  });

  describe("Claim flow - sandbox token generation", () => {
    it("should generate sandbox token without capabilities", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-no-caps"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      const sandboxAuth = verifySandboxToken(data.sandboxToken);
      expect(sandboxAuth).not.toBeNull();
      expect(sandboxAuth!.userId).toBe(user.userId);
    });
  });

  describe("Claim flow - secretValues filtering", () => {
    it("should only include secret values present in environment", async () => {
      const { versionId } = await createTestCompose(
        uniqueId("test-secret-filter"),
      );

      const encryptedSecrets = encryptSecretsMap(
        {
          API_KEY: "sk-real-key",
          AUTH_TOKEN: "placeholder-token",
          UNUSED_SECRET: "should-not-appear",
        },
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        {
          encryptedSecrets,
          environment: {
            API_KEY: "sk-real-key",
            AUTH_TOKEN: "placeholder-token",
            LITERAL_VAR: "not-a-secret",
          },
        },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      // Values present in environment are included
      expect(data.secretValues).toContain("sk-real-key");
      expect(data.secretValues).toContain("placeholder-token");
      // Values NOT in environment are excluded
      expect(data.secretValues).not.toContain("should-not-appear");
    });

    it("should return empty array when no secrets match environment", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-no-match"));

      const encryptedSecrets = encryptSecretsMap(
        { SECRET: "not-in-env" },
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        {
          encryptedSecrets,
          environment: { SOME_VAR: "other-value" },
        },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secretValues).toEqual([]);
    });

    it("should return null when no encrypted secrets exist", async () => {
      const { versionId } = await createTestCompose(
        uniqueId("test-no-secrets"),
      );
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secretValues).toBeNull();
    });
  });

  describe("Claim flow - execution context fields", () => {
    it("should return settings when present in stored context", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-settings"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        { settings: '{"hooks":{}}' },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.settings).toBe('{"hooks":{}}');
    });

    it("should return tools when present in stored context", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-tools"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        { tools: ["Bash", "Edit"] },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.tools).toEqual(["Bash", "Edit"]);
    });

    it("should omit fields when not in stored context", async () => {
      const { versionId } = await createTestCompose(uniqueId("test-no-extras"));
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.settings).toBeUndefined();
      expect(data.tools).toBeUndefined();
    });

    // Regression for #9868 — claim route used to hand-pick fields from
    // storedContext and silently dropped secretConnectorMap, breaking the
    // mitmproxy OAuth refresh path. Pin both secretConnectorMap and
    // encryptedSecrets so any future refactor of the response body can't
    // drop them without tripping a test.
    it("should forward secretConnectorMap and encryptedSecrets to the runner", async () => {
      const { versionId } = await createTestCompose(
        "test-secret-connector-map",
      );

      const encryptedSecrets = encryptSecretsMap(
        { GMAIL_ACCESS_TOKEN: "fake-access-token" },
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );
      const secretConnectorMap = {
        GMAIL_ACCESS_TOKEN: "gmail",
        GMAIL_TOKEN: "gmail",
      };
      const secretConnectorMetadataMap = {
        GMAIL_ACCESS_TOKEN: {
          sourceType: "connector" as const,
        },
      };

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        { encryptedSecrets, secretConnectorMap, secretConnectorMetadataMap },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secretConnectorMap).toEqual(secretConnectorMap);
      expect(data.secretConnectorMetadataMap).toEqual(
        secretConnectorMetadataMap,
      );
      expect(data.encryptedSecrets).toBe(encryptedSecrets);
    });

    it("should forward modelUsageProvider to the runner", async () => {
      const { versionId } = await createTestCompose(
        "test-model-usage-provider",
      );

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        "vm0/default",
        { modelUsageProvider: "claude-opus-4-6" },
      );

      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${runId}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelUsageProvider).toBe("claude-opus-4-6");
    });
  });
});
