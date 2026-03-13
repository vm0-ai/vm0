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
import { Sandbox } from "@e2b/code-interpreter";

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn().mockResolvedValue({
      sandboxId: "mock-sandbox-id",
      files: { write: vi.fn().mockResolvedValue(undefined) },
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0 }) },
    }),
    connect: vi.fn(),
  },
}));

const context = testContext();

// Shared CLI token for authenticated requests
let testCliToken: string;

describe("POST /api/compose/jobs", () => {
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
        "http://localhost:3000/api/compose/jobs",
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
    it("should reject request with empty body", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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
      expect(data.error.message).toContain("Invalid input");
    });

    it("should reject request with invalid GitHub URL", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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

  describe("Job Creation (GitHub)", () => {
    it("should create a new compose job", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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
      expect(data.source).toBe("github");
      expect(data.createdAt).toBeDefined();
    });

    it("should create a job with overwrite option", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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

  describe("Job Creation (Platform Content)", () => {
    const testContent = {
      version: "1",
      agents: {
        "my-agent": {
          framework: "claude-code",
          description: "A test agent",
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/github"],
        },
      },
    };

    it("should create a job from platform content", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({ content: testContent }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe("pending");
      expect(data.source).toBe("platform");
      expect(data.githubUrl).toBeUndefined();
    });

    it("should create a job with content and instructions", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            content: testContent,
            instructions: "# Agent Instructions\nBe helpful.",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe("pending");
      expect(data.source).toBe("platform");
    });

    it("should return existing platform job for idempotency", async () => {
      // Create first platform job
      const request1 = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({ content: testContent }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(201);
      const data1 = await response1.json();

      // Second request should return same job
      const request2 = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            content: {
              version: "1",
              agents: { other: { framework: "codex" } },
            },
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
      const data2 = await response2.json();
      expect(data2.jobId).toBe(data1.jobId);
    });

    it("should complete a platform content job via webhook", async () => {
      const user = await context.setupUser();
      const userCliToken = await createTestCliToken(user.userId);

      // Create job
      const createRequest = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userCliToken}`,
          },
          body: JSON.stringify({ content: testContent }),
        },
      );

      const createResponse = await POST(createRequest);
      expect(createResponse.status).toBe(201);
      const { jobId } = await createResponse.json();

      // Complete via webhook
      const sandboxToken = await createTestComposeJobToken(user.userId, jobId);
      const webhookRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/compose/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({
            jobId,
            success: true,
            result: {
              composeId: "platform-compose-id",
              composeName: "my-agent",
              versionId: "platform-version-id",
              warnings: [],
            },
          }),
        },
      );

      await webhookComplete(webhookRequest);

      // Verify completed status
      const getRequest = createTestRequest(
        `http://localhost:3000/api/compose/jobs/${jobId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userCliToken}` },
        },
      );

      const getResponse = await GET(getRequest);
      expect(getResponse.status).toBe(200);
      const data = await getResponse.json();
      expect(data.status).toBe("completed");
      expect(data.result.composeId).toBe("platform-compose-id");
      expect(data.result.composeName).toBe("my-agent");
      expect(data.completedAt).toBeDefined();
    });
  });

  describe("Idempotency", () => {
    it("should return existing pending job instead of creating new one", async () => {
      // Create first job
      const request1 = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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
        "http://localhost:3000/api/compose/jobs",
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
        "http://localhost:3000/api/compose/jobs",
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
        "http://localhost:3000/api/compose/jobs",
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

describe("GET /api/compose/jobs/:jobId", () => {
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
      "http://localhost:3000/api/compose/jobs",
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
        `http://localhost:3000/api/compose/jobs/${testJobId}`,
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
        `http://localhost:3000/api/compose/jobs/${testJobId}`,
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
        `http://localhost:3000/api/compose/jobs/${testJobId}`,
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
        `http://localhost:3000/api/compose/jobs/${testJobId}`,
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
        `http://localhost:3000/api/compose/jobs/${nonExistentId}`,
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

      const otherJobRequest = createTestRequest(
        "http://localhost:3000/api/compose/jobs",
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

      // Clear Clerk mock so CLI token is used for auth
      mockClerk({ userId: null });

      // Try to access the other user's job with original user's token
      // Clerk is null, so testUserCliToken will be used for auth
      const request = createTestRequest(
        `http://localhost:3000/api/compose/jobs/${otherJobId}`,
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
        "http://localhost:3000/api/compose/jobs/invalid-uuid",
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

describe("Platform session auth (no CLI token)", () => {
  const context = testContext();

  const testContent = {
    version: "1",
    agents: {
      "my-agent": {
        framework: "claude-code",
        description: "A test agent",
      },
    },
  };

  beforeEach(async () => {
    context.setupMocks();
  });

  it("should create a job via Clerk session without Authorization header", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/compose/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: testContent }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.jobId).toBeDefined();
    expect(data.status).toBe("pending");
    expect(data.source).toBe("platform");
  });

  it("should pass a generated vm0_live_ token to sandbox", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/compose/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubUrl: "https://github.com/owner/repo",
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);

    // Verify E2B sandbox was created with a generated vm0_live_ token
    const createCall = vi.mocked(Sandbox.create).mock.calls[0];
    expect(createCall).toBeDefined();
    const sandboxEnvs = createCall![1]?.envs as Record<string, string>;
    expect(sandboxEnvs.VM0_TOKEN).toMatch(/^vm0_live_/);
  });

  it("should create a job with Clerk JWT in Authorization header", async () => {
    // Platform SaaS sends a Clerk JWT as Bearer token — this should still work
    // because getUserId() resolves auth via Clerk session cookies first
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/compose/jobs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake",
        },
        body: JSON.stringify({ content: testContent }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.jobId).toBeDefined();
    expect(data.source).toBe("platform");
  });

  it("should complete full lifecycle: session auth → webhook → poll", async () => {
    const user = await context.setupUser();

    // 1. Create job via session auth (no CLI token)
    const createRequest = createTestRequest(
      "http://localhost:3000/api/compose/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: testContent }),
      },
    );

    const createResponse = await POST(createRequest);
    expect(createResponse.status).toBe(201);
    const { jobId } = await createResponse.json();

    // 2. Complete via webhook
    const sandboxToken = await createTestComposeJobToken(user.userId, jobId);
    const webhookRequest = createTestRequest(
      "http://localhost:3000/api/webhooks/compose/complete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sandboxToken}`,
        },
        body: JSON.stringify({
          jobId,
          success: true,
          result: {
            composeId: "session-compose-id",
            composeName: "my-agent",
            versionId: "session-version-id",
            warnings: [],
          },
        }),
      },
    );

    await webhookComplete(webhookRequest);

    // 3. Poll for completed status (use CLI token for GET — platform would use session)
    const userCliToken = await createTestCliToken(user.userId);
    const getRequest = createTestRequest(
      `http://localhost:3000/api/compose/jobs/${jobId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${userCliToken}` },
      },
    );

    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(200);
    const data = await getResponse.json();
    expect(data.status).toBe("completed");
    expect(data.result.composeId).toBe("session-compose-id");
    expect(data.completedAt).toBeDefined();
  });
});
