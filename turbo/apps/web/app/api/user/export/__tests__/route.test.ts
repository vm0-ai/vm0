import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestRequest,
  findTestExportJobById,
  insertTestComposeWithVersion,
  insertTestAgentSessionWithMessages,
  insertTestArtifactStorage,
  insertTestAgentCompose,
} from "../../../../../src/__tests__/api-test-helpers";

const context = testContext();

function createExportRequest() {
  return createTestRequest("http://localhost:3000/api/user/export", {
    method: "POST",
  });
}

describe("POST /api/user/export", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Authentication", () => {
    it("should reject unauthenticated request", async () => {
      mockClerk({ userId: null });

      const response = await POST(createExportRequest());

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Happy Path", () => {
    it("should create export job and produce ZIP with all data", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      // Create test compose with version
      const { composeId } = await insertTestComposeWithVersion(
        user.userId,
        user.orgId,
        "test-agent",
        {
          version: "1",
          agents: { "test-agent": { framework: "claude-code" } },
        },
      );

      // Create test session with chat messages
      await insertTestAgentSessionWithMessages(user.userId, composeId, [
        {
          role: "user",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "hi there",
          createdAt: new Date().toISOString(),
        },
      ]);

      // Create test artifact storage
      await insertTestArtifactStorage(user.userId, user.orgId, "test-artifact");

      // Trigger export
      const response = await POST(createExportRequest());
      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe("pending");

      // Flush async after() callback
      await context.mocks.flushAfter();

      // Verify job completed
      const job = await findTestExportJobById(data.jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("completed");
      expect(job!.s3Key).toContain("exports/");
      expect(job!.expiresAt).toBeDefined();
      expect(job!.completedAt).toBeDefined();

      // Verify S3 upload was called
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalled();

      // Verify the uploaded buffer targets the exports path
      const uploadCalls = context.mocks.s3.uploadS3Buffer.mock.calls;
      const exportUpload = uploadCalls.find((call) =>
        (call[1] as string).startsWith("exports/"),
      );
      expect(exportUpload).toBeDefined();

      // Verify presigned URL was generated for artifact
      expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalled();
    });
  });

  describe("Rate Limiting", () => {
    it("should reject export within 24 hours of previous", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      // First export
      const response1 = await POST(createExportRequest());
      expect(response1.status).toBe(202);
      await context.mocks.flushAfter();

      // Second export (should be rate limited)
      const response2 = await POST(createExportRequest());
      expect(response2.status).toBe(429);
      const data2 = await response2.json();
      expect(data2.error.code).toBe("RATE_LIMITED");
    });

    it("should allow export after 24 hours", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      // First export
      const response1 = await POST(createExportRequest());
      expect(response1.status).toBe(202);
      await context.mocks.flushAfter();

      // Time travel 25 hours
      const twentyFiveHoursLater = new Date(Date.now() + 25 * 60 * 60 * 1000);
      context.mocks.date.setSystemTime(twentyFiveHoursLater);

      // Second export (should succeed after cooldown)
      const response2 = await POST(createExportRequest());
      expect(response2.status).toBe(202);
    });
  });

  describe("Idempotency", () => {
    it("should return existing active job instead of creating new one", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      // First export (don't flush - job stays pending)
      const response1 = await POST(createExportRequest());
      expect(response1.status).toBe(202);
      const data1 = await response1.json();

      // Second export (should return same job)
      const response2 = await POST(createExportRequest());
      expect(response2.status).toBe(202);
      const data2 = await response2.json();

      expect(data2.jobId).toBe(data1.jobId);
    });
  });

  describe("Empty Data", () => {
    it("should produce export with only manifest for user with no data", async () => {
      const user = await context.setupUser();
      mockClerk({ userId: user.userId, orgId: user.orgId });

      const response = await POST(createExportRequest());
      expect(response.status).toBe(202);
      const data = await response.json();

      await context.mocks.flushAfter();

      // Verify job completed
      const job = await findTestExportJobById(data.jobId);
      expect(job!.status).toBe("completed");
      expect(job!.artifactUrls).toBeNull();

      // Verify ZIP was uploaded (even though it's mostly empty)
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalled();
    });
  });

  describe("User Isolation", () => {
    it("should not include other user data in export", async () => {
      // User A creates data
      const userA = await context.setupUser();
      mockClerk({ userId: userA.userId, orgId: userA.orgId });

      await insertTestAgentCompose(userA.userId, userA.scopeId, "user-a-agent");

      // User B triggers export
      const userB = await context.setupUser({ prefix: "other" });
      mockClerk({ userId: userB.userId, orgId: userB.orgId });

      const response = await POST(createExportRequest());
      expect(response.status).toBe(202);
      await context.mocks.flushAfter();

      const data = await response.json();
      const job = await findTestExportJobById(data.jobId);
      expect(job!.status).toBe("completed");
      // User B's export should not contain User A's artifact URLs
      expect(job!.artifactUrls).toBeNull();
    });
  });
});
