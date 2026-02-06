import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestComposeJobToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { composeJobs } from "../../../../../../src/db/schema/compose-job";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/webhooks/compose/complete", () => {
  let user: UserContext;
  let testJobId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create a test job directly in DB
    testJobId = randomUUID();
    await globalThis.services.db.insert(composeJobs).values({
      id: testJobId,
      userId: user.userId,
      githubUrl: "https://github.com/owner/repo",
      overwrite: false,
      status: "running",
      startedAt: new Date(),
    });

    // Generate JWT token for sandbox auth
    testToken = await createTestComposeJobToken(user.userId, testJobId);

    // Reset auth mock for webhook tests (which use token auth, not Clerk)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject request with invalid token", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer invalid-token",
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request when token jobId does not match", async () => {
      const differentJobId = randomUUID();

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: differentJobId, // Different from token
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("Token does not match");
    });
  });

  describe("Validation", () => {
    it("should reject request without jobId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("jobId");
    });

    it("should reject request without success flag", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("success");
    });
  });

  describe("Success Completion", () => {
    it("should handle successful completion", async () => {
      const result = {
        composeId: "test-compose-id",
        composeName: "test-compose",
        versionId: "test-version-id",
        warnings: [],
      };

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify job was updated
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, testJobId));

      expect(job?.status).toBe("completed");
      expect(job?.result).toEqual(result);
      expect(job?.completedAt).toBeDefined();
    });

    it("should handle successful completion with warnings", async () => {
      const result = {
        composeId: "test-compose-id",
        composeName: "test-compose",
        versionId: "test-version-id",
        warnings: ["Some deprecated field used"],
      };

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify warnings were stored
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, testJobId));

      expect(job?.result?.warnings).toEqual(["Some deprecated field used"]);
    });
  });

  describe("Failed Completion", () => {
    it("should handle failed completion with error", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: false,
            error: "Failed to parse vm0.yaml",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify job was updated
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, testJobId));

      expect(job?.status).toBe("failed");
      expect(job?.error).toBe("Failed to parse vm0.yaml");
      expect(job?.completedAt).toBeDefined();
    });
  });

  describe("Idempotency", () => {
    it("should accept duplicate success completion", async () => {
      // Mark job as completed first
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          result: {
            composeId: "original-compose-id",
            composeName: "test-compose",
            versionId: "original-version-id",
            warnings: [],
          },
        })
        .where(eq(composeJobs.id, testJobId));

      // Try to complete again
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result: {
              composeId: "different-compose-id",
              composeName: "different-compose",
              versionId: "different-version-id",
              warnings: [],
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify original result was not changed
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, testJobId));

      expect(job?.result?.composeId).toBe("original-compose-id");
    });

    it("should accept duplicate failed completion", async () => {
      // Mark job as failed first
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: "Original error",
        })
        .where(eq(composeJobs.id, testJobId));

      // Try to fail again
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: false,
            error: "Different error",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify original error was not changed
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, testJobId));

      expect(job?.error).toBe("Original error");
    });
  });

  describe("Errors", () => {
    it("should return 404 for non-existent job", async () => {
      const nonExistentId = randomUUID();
      const tokenForNonExistent = await createTestComposeJobToken(
        user.userId,
        nonExistentId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistent}`,
          },
          body: JSON.stringify({
            jobId: nonExistentId,
            success: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
