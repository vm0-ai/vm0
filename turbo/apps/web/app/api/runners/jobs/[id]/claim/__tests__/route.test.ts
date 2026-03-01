import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  createTestRequest,
  createTestCliToken,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { runnerJobQueue } from "../../../../../../../src/db/schema/runner-job-queue";
import { scopes } from "../../../../../../../src/db/schema/scope";
import { encryptSecrets } from "../../../../../../../src/lib/crypto/secrets-encryption";

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
    it("should return agentName and agentScopeSlug in claim response", async () => {
      // Look up user's scope slug
      const [scope] = await globalThis.services.db
        .select({ slug: scopes.slug })
        .from(scopes)
        .where(eq(scopes.id, user.scopeId))
        .limit(1);

      // Create compose (links to user's scope)
      const { versionId } = await createTestCompose("test-agent");

      // Create run record
      const [run] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: user.userId,
          agentComposeVersionId: versionId,
          status: "pending",
          prompt: "test prompt",
        })
        .returning({ id: agentRuns.id });

      // Queue runner job with agent metadata in stored context
      const runnerGroup = `${scope!.slug}/default`;
      const encryptedSecrets = encryptSecrets(
        null,
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );

      await globalThis.services.db.insert(runnerJobQueue).values({
        runId: run!.id,
        runnerGroup,
        executionContext: {
          workingDir: "/home/user",
          storageManifest: null,
          environment: null,
          resumeSession: null,
          encryptedSecrets,
          cliAgentType: "claude",
          agentName: "test-agent",
          agentScopeSlug: scope!.slug,
        },
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      // Claim the job
      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${run!.id}/claim`,
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
      expect(data.agentScopeSlug).toBe(scope!.slug);
    });

    it("should omit agentName and agentScopeSlug when not set in stored context", async () => {
      // Look up user's scope slug
      const [scope] = await globalThis.services.db
        .select({ slug: scopes.slug })
        .from(scopes)
        .where(eq(scopes.id, user.scopeId))
        .limit(1);

      // Create compose
      const { versionId } = await createTestCompose("test-agent-no-meta");

      // Create run record
      const [run] = await globalThis.services.db
        .insert(agentRuns)
        .values({
          userId: user.userId,
          agentComposeVersionId: versionId,
          status: "pending",
          prompt: "test prompt",
        })
        .returning({ id: agentRuns.id });

      // Queue runner job WITHOUT agent metadata
      const runnerGroup = `${scope!.slug}/default`;
      const encryptedSecrets = encryptSecrets(
        null,
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );

      await globalThis.services.db.insert(runnerJobQueue).values({
        runId: run!.id,
        runnerGroup,
        executionContext: {
          workingDir: "/home/user",
          storageManifest: null,
          environment: null,
          resumeSession: null,
          encryptedSecrets,
          cliAgentType: "claude",
        },
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      // Claim the job
      const token = await createTestCliToken(user.userId);
      const request = createTestRequest(
        `http://localhost:3000/api/runners/jobs/${run!.id}/claim`,
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
      expect(data.agentScopeSlug).toBeUndefined();
    });
  });
});
