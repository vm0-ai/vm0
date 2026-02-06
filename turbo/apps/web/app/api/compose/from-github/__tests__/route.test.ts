import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { GET } from "../[jobId]/route";
import { POST as webhookComplete } from "../../../webhooks/compose/complete/route";
import {
  createTestRequest,
  createTestComposeJobToken,
  createTestCliToken,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

// Shared CLI token for authenticated requests
let testCliToken: string;

describe("POST /api/compose/from-github", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    // Create CLI token for this user
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/repo",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Validation", () => {
    it("should reject request without githubUrl", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("githubUrl");
    });

    it("should reject request with invalid GitHub URL", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://gitlab.com/owner/repo",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("Job Creation", () => {
    it("should create a new compose job", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/repo",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe("pending");
      expect(data.githubUrl).toBe("https://github.com/owner/repo");
      expect(data.createdAt).toBeDefined();
    });

    it("should create a job with overwrite option", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/repo",
            overwrite: true,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.jobId).toBeDefined();
    });
  });

  describe("Idempotency", () => {
    it("should return existing pending job instead of creating new one", async () => {
      // Create first job
      const request1 = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/repo",
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(201);
      const data1 = await response1.json();
      const jobId1 = data1.jobId;

      // Create second job (should return same job)
      const request2 = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/other/repo",
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200); // 200 for existing job
      const data2 = await response2.json();

      expect(data2.jobId).toBe(jobId1);
    });

    it("should create new job after previous one completes", async () => {
      const user = await context.setupUser();
      // Create CLI token for this specific user
      const userCliToken = await createTestCliToken(user.userId);

      // Create first job
      const request1 = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/owner/repo",
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(201);
      const data1 = await response1.json();
      const jobId1 = data1.jobId;

      // Complete first job via webhook using test helper to generate token
      const sandboxToken = await createTestComposeJobToken(user.userId, jobId1);
      const webhookRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({
            jobId: jobId1,
            success: true,
            result: {
              composeId: "test-compose-id",
              composeName: "test-compose",
              versionId: "test-version-id",
              warnings: [],
            },
          }),
        },
      );

      await webhookComplete(webhookRequest);

      // Create second job (should create new job)
      const request2 = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/other/repo",
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(201); // 201 for new job
      const data2 = await response2.json();

      expect(data2.jobId).not.toBe(jobId1);
    });
  });
});

describe("GET /api/compose/from-github/:jobId", () => {
  let testJobId: string;
  let testUserId: string;
  let testUserCliToken: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;
    testUserCliToken = await createTestCliToken(user.userId);

    // Create a test job
    const request = createTestRequest(
      "http://localhost:3000/api/compose/from-github",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testUserCliToken}`,
        },
        body: JSON.stringify({
          githubUrl: "https://github.com/owner/repo",
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();
    testJobId = data.jobId;
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${testJobId}`,
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe("Success", () => {
    it("should return job status", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${testJobId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.jobId).toBe(testJobId);
      expect(data.status).toBeDefined();
      expect(data.githubUrl).toBe("https://github.com/owner/repo");
    });

    it("should return completed job with result", async () => {
      // Complete job via webhook using test helper to generate token
      const sandboxToken = await createTestComposeJobToken(
        testUserId,
        testJobId,
      );
      const webhookRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: true,
            result: {
              composeId: "test-compose-id",
              composeName: "test-compose",
              versionId: "test-version-id",
              warnings: [],
            },
          }),
        },
      );

      await webhookComplete(webhookRequest);

      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${testJobId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("completed");
      expect(data.result).toBeDefined();
      expect(data.result.composeId).toBe("test-compose-id");
      expect(data.completedAt).toBeDefined();
    });

    it("should return failed job with error", async () => {
      // Fail job via webhook using test helper to generate token
      const sandboxToken = await createTestComposeJobToken(
        testUserId,
        testJobId,
      );
      const webhookRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({
            jobId: testJobId,
            success: false,
            error: "Failed to parse vm0.yaml",
          }),
        },
      );

      await webhookComplete(webhookRequest);

      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${testJobId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("failed");
      expect(data.error).toBe("Failed to parse vm0.yaml");
    });
  });

  describe("Errors", () => {
    it("should return 404 for non-existent job", async () => {
      const nonExistentId = randomUUID();

      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${nonExistentId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 for job owned by different user", async () => {
      // Create another user and their CLI token
      // Note: setupUser will mock Clerk for this user
      const otherUser = await context.setupUser({ prefix: "other" });
      const otherCliToken = await createTestCliToken(otherUser.userId);

      // Clear Clerk mock so CLI token is used for auth
      mockClerk({ userId: null });

      const otherJobRequest = createTestRequest(
        "http://localhost:3000/api/compose/from-github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${otherCliToken}`,
          },
          body: JSON.stringify({
            githubUrl: "https://github.com/other/repo",
          }),
        },
      );

      const otherJobResponse = await POST(otherJobRequest);
      const otherJobData = await otherJobResponse.json();
      const otherJobId = otherJobData.jobId;

      // Try to access the other user's job with original user's token
      // Clerk is null, so testUserCliToken will be used for auth
      const request = createTestRequest(
        `http://localhost:3000/api/compose/from-github/${otherJobId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
    });

    it("should return 400 for invalid job ID format", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/from-github/invalid-uuid",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${testUserCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(400);
    });
  });
});
