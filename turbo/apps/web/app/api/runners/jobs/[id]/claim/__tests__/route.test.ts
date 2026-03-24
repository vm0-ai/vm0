import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCliToken,
  createTestCompose,
  createTestRunnerJob,
  findTestComposeWithOrg,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { encryptSecretsMap } from "../../../../../../../src/lib/crypto/secrets-encryption";
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
              Authorization: "Bearer vm0_live_nonexistent_token",
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
    it("should return agentName and agentOrgSlug in claim response", async () => {
      // Create compose and look up org slug
      const { composeId, versionId } = await createTestCompose("test-agent");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      // Create runner job with agent metadata in stored context
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
        {
          agentName: "test-agent",
          agentOrgSlug: orgSlug,
          agentComposeId: composeId,
        },
      );

      // Claim the job
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
      expect(data.agentName).toBe("test-agent");
      expect(data.agentOrgSlug).toBe(orgSlug);
      expect(data.agentComposeId).toBe(composeId);
    });

    it("should omit agentName and agentOrgSlug when not set in stored context", async () => {
      // Create compose and look up org slug
      const { composeId, versionId } =
        await createTestCompose("test-agent-no-meta");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      // Create runner job WITHOUT agent metadata
      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
      );

      // Claim the job
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
      expect(data.agentName).toBeUndefined();
      expect(data.agentOrgSlug).toBeUndefined();
      expect(data.agentComposeId).toBeUndefined();
    });

    it("should return appendSystemPrompt in claim response", async () => {
      const { composeId, versionId } = await createTestCompose("test-asp");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      const { composeId, versionId } = await createTestCompose("test-asp-null");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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

  describe("Claim flow - capabilities in sandbox token", () => {
    it("should include capabilities in returned sandbox token", async () => {
      const { composeId, versionId } = await createTestCompose("test-caps");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
        {
          experimentalCapabilities: ["agent:read", "agent:write"],
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
      const sandboxAuth = verifySandboxToken(data.sandboxToken);
      expect(sandboxAuth).not.toBeNull();
      expect(sandboxAuth!.capabilities).toEqual(["agent:read", "agent:write"]);
    });

    it("should generate token without capabilities when not in stored context", async () => {
      const { composeId, versionId } = await createTestCompose("test-no-caps");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      expect(sandboxAuth!.capabilities).toBeUndefined();
    });
  });

  describe("Claim flow - secretValues filtering", () => {
    it("should only include secret values present in environment", async () => {
      const { composeId, versionId } =
        await createTestCompose("test-secret-filter");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

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
        `${orgSlug}/default`,
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
      const { composeId, versionId } = await createTestCompose("test-no-match");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const encryptedSecrets = encryptSecretsMap(
        { SECRET: "not-in-env" },
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      const { composeId, versionId } =
        await createTestCompose("test-no-secrets");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      const { composeId, versionId } = await createTestCompose("test-settings");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      const { composeId, versionId } = await createTestCompose("test-tools");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
      const { composeId, versionId } =
        await createTestCompose("test-no-extras");
      const composeInfo = await findTestComposeWithOrg(composeId);
      const orgSlug = composeInfo!.orgSlug;

      const { runId } = await createTestRunnerJob(
        user.userId,
        versionId,
        `${orgSlug}/default`,
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
  });
});
