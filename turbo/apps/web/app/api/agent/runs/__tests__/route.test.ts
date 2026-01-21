import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { POST } from "../route";
import { POST as createCompose } from "../../composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../src/test/api-test-helpers";
import { Sandbox } from "@e2b/code-interpreter";
import * as s3Client from "../../../../../src/lib/s3/s3-client";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock E2B SDK (external)
vi.mock("@e2b/code-interpreter");

// Mock AWS SDK (external) for S3 operations
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/agent/runs - Fire-and-Forget Execution", () => {
  // Generate unique IDs for this test run
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-runs-${Date.now()}`;
  const testScopeId = randomUUID();
  let testComposeId: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Setup E2B SDK mock - create sandbox
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: () => "test-sandbox.e2b.dev",
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "Mock output",
          stderr: "",
          exitCode: 0,
        }),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Sandbox.create).mockResolvedValue(
      mockSandbox as unknown as Sandbox,
    );

    // Setup S3 mocks
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Mock headers() - not needed for this endpoint since we use Clerk auth
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Clean up test data from previous runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testComposeId = data.composeId;
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  afterAll(async () => {});

  // ============================================
  // Fire-and-Forget Execution Tests
  // ============================================

  describe("Fire-and-Forget Execution", () => {
    it("should return immediately with 'running' status after sandbox preparation", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test prompt",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const endTime = Date.now();

      // Should return quickly (sandbox prep only, not agent execution)
      expect(endTime - startTime).toBeLessThan(5000);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("running");

      // Verify run was created in database with 'running' status
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(run).toBeDefined();
      expect(run!.status).toBe("running");
      expect(run!.prompt).toBe("Test prompt");
      expect(run!.sandboxId).toBe("test-sandbox-123");
    });

    it("should update sandboxId in database after successful preparation", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test sandbox ID",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Check that sandboxId was saved in database
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(run!.sandboxId).toBe("test-sandbox-123");
      expect(run!.status).toBe("running");
      // completedAt should NOT be set yet (agent still running)
      expect(run!.completedAt).toBeNull();
    });

    it("should return 'failed' status if sandbox preparation fails", async () => {
      // Make E2B SDK throw an error
      vi.mocked(Sandbox.create).mockRejectedValue(
        new Error("Sandbox creation failed"),
      );

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test preparation failure",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      // Returns failed status immediately for preparation failures
      expect(data.status).toBe("failed");

      // Check that run was marked as failed in database
      const [failedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, data.runId))
        .limit(1);

      expect(failedRun!.status).toBe("failed");
      expect(failedRun!.error).toContain("Sandbox creation failed");
      expect(failedRun!.completedAt).toBeDefined();
    });

    it("should return quickly even with complex context building", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Quick response test",
        }),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const responseTime = Date.now() - startTime;

      // Should return after sandbox prep, not after agent execution
      expect(responseTime).toBeLessThan(5000);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.status).toBe("running");
    });
  });

  // ============================================
  // Validation Tests (ensure they still work)
  // ============================================

  describe("Validation", () => {
    it("should reject request without agentComposeId", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("agentComposeId");
    });

    it("should reject request without prompt", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("prompt");
    });

    it("should reject request with both checkpointId and sessionId", async () => {
      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Test prompt",
          checkpointId: randomUUID(),
          sessionId: randomUUID(),
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("both checkpointId and sessionId");
    });
  });

  // ============================================
  // Authorization Tests
  // ============================================

  describe("Authorization", () => {
    it("should reject unauthenticated request", async () => {
      // Mock Clerk to return no user
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should reject request for non-existent compose", async () => {
      const nonExistentComposeId = randomUUID();

      const request = new NextRequest("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: nonExistentComposeId,
          prompt: "Test prompt",
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent compose");
    });
  });
});
