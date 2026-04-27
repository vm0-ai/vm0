import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  getOrgCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { setTestCheckpointArtifactSnapshots } from "../../../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

describe("GET /api/agent/checkpoints/:id", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose
    const { composeId } = await createTestCompose(uniqueId("checkpoint"));
    testComposeId = composeId;
  });

  it("should return checkpoint with agentComposeSnapshot including secretNames", async () => {
    // Create run and complete it (creates checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test checkpoint");
    const { checkpointId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${checkpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(checkpointId);
    expect(data.runId).toBe(runId);
    expect(data.conversationId).toBeDefined();
    expect(data.agentComposeSnapshot).toBeDefined();
    expect(data.agentComposeSnapshot.agentComposeVersionId).toBeDefined();
    expect(data.createdAt).toBeDefined();
  });

  it("should return 404 for non-existent checkpoint", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${nonExistentId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("Checkpoint not found");
  });

  it("should return 404 when accessing another user's checkpoint", async () => {
    // Create another user with their own compose and run
    const otherUser = await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-checkpoint-${Date.now()}`,
    );

    // Create and complete run for other user (creates checkpoint)
    const otherRun = await createTestRun(otherComposeId, "Other user run");
    const { checkpointId: otherCheckpointId } = await completeTestRun(
      otherUser.userId,
      otherRun.runId,
    );

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's checkpoint
    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${otherCheckpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 for checkpoint from a different org", async () => {
    // Create compose in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    const otherOrgEntry = await getOrgCacheEntry(otherOrg.orgId);

    // Switch to the other org and create compose + run there
    mockClerk({
      userId: user.userId,
      orgId: otherOrg.orgId,
      orgSlug: otherOrgEntry!.slug,
      clerkOrgs: [
        {
          id: otherOrg.orgId,
          slug: otherOrgEntry!.slug,
          name: otherOrgEntry!.slug,
        },
      ],
    });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-org-checkpoint-${Date.now()}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other org run",
    );
    const { checkpointId: otherCheckpointId } = await completeTestRun(
      user.userId,
      otherRunId,
    );

    // Switch back to default org
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${otherCheckpointId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should project array-shape artifactSnapshots to Record on the response wire", async () => {
    // Post-#10911 guest-agents persist Array<{name, version, mountPath}> in
    // the JSONB column. The outbound wire stays Record-shaped for CLI
    // consumers, so the GET handler must normalise.
    const { runId } = await createTestRun(testComposeId, "Array snapshot");
    const { checkpointId } = await completeTestRun(user.userId, runId);

    await setTestCheckpointArtifactSnapshots(checkpointId, [
      { name: "frontend", version: "v-fe-1", mountPath: "/workspace/fe" },
      { name: "backend", version: "v-be-2", mountPath: "/workspace/be" },
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${checkpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.artifactSnapshots).toEqual({
      frontend: "v-fe-1",
      backend: "v-be-2",
    });
  });

  it("should return 401 when not authenticated", async () => {
    // Create run and complete it (creates checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test checkpoint");
    const { checkpointId } = await completeTestRun(user.userId, runId);

    // Mock Clerk to return no user
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/checkpoints/${checkpointId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
