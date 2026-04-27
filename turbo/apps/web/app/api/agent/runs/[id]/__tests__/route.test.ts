import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  insertOrgCacheEntry,
  insertOrgMembersCacheEntry,
  getOrgCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  generateSandboxToken,
  generateZeroToken,
} from "../../../../../../src/lib/auth/sandbox-token";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

describe("GET /api/agent/runs/:id - Get Run By ID", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("Successful Retrieval", () => {
    it("should return run details with all expected fields", async () => {
      const run = await createTestRun(testComposeId, "Test prompt");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.runId).toBe(run.runId);
      expect(data.prompt).toBe("Test prompt");
      expect(data.status).toBe("pending");
      expect(data.completedAt).toBeUndefined();
      expect(data).toHaveProperty("agentComposeVersionId");
      expect(data).toHaveProperty("createdAt");
    });

    it("should return completed run with result", async () => {
      const run = await createTestRun(testComposeId, "Run to complete");

      // Complete the run
      await completeTestRun(user.userId, run.runId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("completed");
      expect(data.completedAt).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should return 401 for unauthenticated request", async () => {
      const run = await createTestRun(testComposeId, "Test run");

      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${fakeId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    // Regression for #11126: short non-UUID id used to flow into drizzle and
    // surface as a postgres `22P02 invalid input syntax for type uuid` 500.
    it("should return 400 when id is not a valid UUID", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs/2b9b2303",
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should return 404 for run belonging to another user", async () => {
      // Create another user and their run
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        uniqueId("other-agent"),
      );

      // Create run as other user
      mockClerk({ userId: otherUser.userId });
      const otherRun = await createTestRun(otherComposeId, "Other user run");

      // Switch back to original user and try to access other user's run
      mockClerk({ userId: user.userId });
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRun.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      // Should return 404 to avoid leaking existence of other user's run
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });
  });

  describe("Org-Scoped Filtering", () => {
    it("should return 404 for run from a different org", async () => {
      // Create a compose + run in a different org
      const otherOrg = await context.createAgentCompose(user.userId);
      const { runId } = await seedTestRun(user.userId, otherOrg.id, {
        status: "running",
        prompt: "Other org run",
      });

      // Default user is in the default org — the run belongs to otherOrg
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${runId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return run when switching to the correct org", async () => {
      // Create a compose + run in a different org
      const otherOrg = await context.createAgentCompose(user.userId);
      const { runId } = await seedTestRun(user.userId, otherOrg.id, {
        status: "running",
        prompt: "Other org run",
      });

      // Switch Clerk mock to the other org
      const orgEntry = await getOrgCacheEntry(otherOrg.orgId);
      mockClerk({
        userId: user.userId,
        orgId: otherOrg.orgId,
        orgSlug: orgEntry!.slug,
        clerkOrgs: [
          { id: otherOrg.orgId, slug: orgEntry!.slug, name: orgEntry!.slug },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${runId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.runId).toBe(runId);
    });
  });

  describe("Sandbox Token Capability Enforcement", () => {
    it("should accept sandbox token with agent-run:read", async () => {
      const run = await createTestRun(testComposeId, "Test prompt");

      // Refresh caches with current Date.now() timestamp
      // (a previous test may have advanced Date.now via dateNow mock)
      await insertOrgCacheEntry({
        orgId: user.orgId,
        slug: (await getOrgCacheEntry(user.orgId))!.slug,
        cachedAt: new Date(Date.now()),
      });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
        cachedAt: new Date(Date.now()),
      });

      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, run.runId, user.orgId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should accept sandbox token with any capability", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-1",
        "org-test",
      );

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${randomUUID()}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      // acceptAnySandboxCapability allows any valid sandbox token
      expect(response.status).not.toBe(403);
    });
  });
});
