import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  insertOrgCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

describe("GET /api/agent/sessions/:id", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("session"));
    testComposeId = composeId;
  });

  it("should return session with all fields", async () => {
    // Create run and complete it (creates session via checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test session");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(agentSessionId);
    expect(data.agentComposeId).toBe(testComposeId);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 404 for non-existent session", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Session not found");
  });

  it("should return 403 when accessing another user's session", async () => {
    // Create another user and their compose/session
    const otherUser = await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-session-${Date.now()}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other user run",
    );
    const { agentSessionId: otherSessionId } = await completeTestRun(
      otherUser.userId,
      otherRunId,
    );

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's session
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${otherSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return 404 when accessing session from a different org", async () => {
    // Create run and complete it under org A (user's default org)
    const { runId } = await createTestRun(testComposeId, "Test session");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Switch to org B — different org for the same user
    const otherOrgId = uniqueId("org-other");
    const otherOrgSlug = uniqueId("org-other");
    await insertOrgCacheEntry({ orgId: otherOrgId, slug: otherOrgSlug });
    mockClerk({
      userId: user.userId,
      orgId: otherOrgId,
      orgSlug: otherOrgSlug,
      clerkOrgs: [{ id: otherOrgId, slug: otherOrgSlug, name: otherOrgSlug }],
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should validate session access using runtime org, not compose org", async () => {
    // Scenario: compose belongs to org-A (user's default), but run executes in org-B.
    // Session's orgId = org-B (runtime org). Accessing from org-B should succeed.

    const orgBId = uniqueId("org-b");
    const orgBSlug = uniqueId("org-b");
    await insertOrgCacheEntry({ orgId: orgBId, slug: orgBSlug });

    // Create a run under org-B (bypassing API to set custom orgId)
    const { runId } = await seedTestRun(user.userId, testComposeId, {
      orgId: orgBId,
    });
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Switch to org-B
    mockClerk({
      userId: user.userId,
      orgId: orgBId,
      orgSlug: orgBSlug,
      clerkOrgs: [{ id: orgBId, slug: orgBSlug, name: orgBSlug }],
    });

    // Access session from org-B — should succeed since session.orgId = org-B
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(agentSessionId);

    // Now switch back to org-A (compose's org) — should fail since session.orgId = org-B
    mockClerk({ userId: user.userId });

    const request2 = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(response2.status).toBe(404);
    expect(data2.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 when not authenticated", async () => {
    // Create run and complete it (creates session)
    const { runId } = await createTestRun(testComposeId, "Test session");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Mock Clerk to return no user
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
