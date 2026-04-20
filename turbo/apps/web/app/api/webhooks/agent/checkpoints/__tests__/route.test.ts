import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestCheckpoint,
  findTestRunRecord,
  getTestAgentSessionWithConversation,
  createTestAgentSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import { createHash, randomUUID } from "crypto";
import type { VolumeVersionsSnapshot } from "../../../../../../src/lib/infra/checkpoint/types";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const context = testContext();

describe("POST /api/webhooks/agent/checkpoints", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create compose for test runs
    const { composeId } = await createTestCompose(uniqueId("checkpoint"));
    testComposeId = composeId;

    // Create a running run
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(user.userId, testRunId);

    // Reset auth mock for webhook tests (which use token auth, not Clerk)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject checkpoint without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should reject checkpoint without runId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject checkpoint without cliAgentSessionId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            // cliAgentSessionId: missing
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("cliAgentSessionId");
    });

    it("should reject checkpoint without cliAgentSessionHistoryHash", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            // cliAgentSessionHistoryHash: missing
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("cliAgentSessionHistoryHash");
    });

    it("should accept checkpoint without artifactSnapshot (optional artifact)", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session-no-artifact",
            cliAgentSessionHistoryHash: sha256("test-session-history"),
            // artifactSnapshot: optional - runs without artifact don't have one
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      expect(data.artifact).toBeUndefined();
    });
  });

  describe("Authorization", () => {
    it("should reject checkpoint for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject checkpoint for run owned by different user", async () => {
      // Create another user with their own run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-compose-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Switch back to original user and reset Clerk mock
      mockClerk({ userId: null });

      // Generate token for the original user but try to access other user's run
      const tokenWithWrongUser = await createTestSandboxToken(
        user.userId,
        otherRunId, // other user's run
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenWithWrongUser}`,
          },
          body: JSON.stringify({
            runId: otherRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "version-123",
            },
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success", () => {
    it("should create checkpoint with artifact snapshot", async () => {
      const artifactSnapshot = {
        artifactName: "test-artifact",
        artifactVersion: "version-123-456",
      };

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "test-session-456",
            cliAgentSessionHistoryHash: sha256("test-session-456-history"),
            artifactSnapshot,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.checkpointId).toBeDefined();
      expect(data.agentSessionId).toBeDefined();
      expect(data.conversationId).toBeDefined();
      expect(data.artifact).toEqual(artifactSnapshot);
    });
  });

  describe("Session independence", () => {
    it("should create independent sessions for separate artifact runs", async () => {
      const artifactSnapshot = {
        artifactName: "my-app",
        artifactVersion: "v1",
      };

      // Allow multiple concurrent runs and re-enable Clerk auth for API route calls
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();
      mockClerk({ userId: user.userId });
      const { runId: runId1 } = await createTestRun(testComposeId, "Run 1");
      const { runId: runId2 } = await createTestRun(testComposeId, "Run 2");
      mockClerk({ userId: null });

      const token1 = await createTestSandboxToken(user.userId, runId1);
      const token2 = await createTestSandboxToken(user.userId, runId2);

      const request1 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            runId: runId1,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-run-1",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot,
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);
      const data1 = await response1.json();

      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token2}`,
          },
          body: JSON.stringify({
            runId: runId2,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-run-2",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            artifactSnapshot,
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
      const data2 = await response2.json();

      // Each run should get its own independent session
      expect(data1.agentSessionId).not.toBe(data2.agentSessionId);
    });

    it("should reuse session when continuedFromSessionId is set", async () => {
      // Create a session via first run's checkpoint
      const request1 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-original",
            cliAgentSessionHistoryHash:
              "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);
      const data1 = await response1.json();
      const originalSessionId = data1.agentSessionId;

      // Create a continue run with continuedFromSessionId
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();
      mockClerk({ userId: user.userId });
      const { runId: continueRunId } = await createTestRun(
        testComposeId,
        "Continue prompt",
        { sessionId: originalSessionId },
      );
      mockClerk({ userId: null });

      const continueToken = await createTestSandboxToken(
        user.userId,
        continueRunId,
      );

      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${continueToken}`,
          },
          body: JSON.stringify({
            runId: continueRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-continued",
            cliAgentSessionHistoryHash: sha256("test-continued"),
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
      const data2 = await response2.json();

      // Continue run should reuse the same session
      expect(data2.agentSessionId).toBe(originalSessionId);
    });
  });

  describe("Uniqueness", () => {
    it("should handle duplicate checkpoint requests via upsert", async () => {
      const requestBody = {
        runId: testRunId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "test-session-unique",
        cliAgentSessionHistoryHash: sha256("test-session-unique-history"),
        artifactSnapshot: {
          artifactName: "test-artifact",
          artifactVersion: "version-123",
        },
      };

      // First request - should succeed
      const request1 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify(requestBody),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second request - should succeed via upsert (update existing)
      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify(requestBody),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
    });
  });

  describe("Additional volumes enrichment", () => {
    it("should enrich checkpoint snapshot with additional volumes from run record", async () => {
      // Seed a run directly with additional volumes (bypasses storage resolution)
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        prompt: "Run with additional volumes",
        additionalVolumes: [
          { name: "my-data", version: "latest", mountPath: "/data" },
          { name: "my-config", mountPath: "/config" },
        ],
      });

      const token = await createTestSandboxToken(user.userId, runId);

      // Create checkpoint with volume versions snapshot (simulating runner report)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-additional-volumes",
            cliAgentSessionHistoryHash: sha256("additional-volumes-history"),
            volumeVersionsSnapshot: {
              versions: {
                "my-data": "abc123hash",
                "my-config": "def456hash",
              },
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify checkpoint JSONB contains enriched additionalVolumes
      const checkpoint = await findTestCheckpoint(runId);
      expect(checkpoint).toBeDefined();

      const snapshot = checkpoint!
        .volumeVersionsSnapshot as unknown as VolumeVersionsSnapshot;
      expect(snapshot.versions).toEqual({
        "my-data": "abc123hash",
        "my-config": "def456hash",
      });
      expect(snapshot.additionalVolumes).toEqual([
        { name: "my-data", versionId: "abc123hash", mountPath: "/data" },
        { name: "my-config", versionId: "def456hash", mountPath: "/config" },
      ]);
    });

    it("should not include additionalVolumes in snapshot when run has no additional volumes", async () => {
      // Create checkpoint for testRunId (which has no additional volumes)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-no-additional",
            cliAgentSessionHistoryHash: sha256("no-additional-history"),
            volumeVersionsSnapshot: {
              versions: { "compose-vol": "xyz789hash" },
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const checkpoint = await findTestCheckpoint(testRunId);
      expect(checkpoint).toBeDefined();

      const snapshot = checkpoint!
        .volumeVersionsSnapshot as unknown as VolumeVersionsSnapshot;
      expect(snapshot.versions).toEqual({ "compose-vol": "xyz789hash" });
      expect(snapshot.additionalVolumes).toBeUndefined();
    });

    it("should fall back to run version when volume not in runner versions map", async () => {
      // Seed a run with additional volume specifying a version
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        prompt: "Run with versioned additional volume",
        additionalVolumes: [
          { name: "my-vol", version: "v1.0", mountPath: "/mnt" },
        ],
      });

      const token = await createTestSandboxToken(user.userId, runId);

      // Create checkpoint WITHOUT the additional volume in versions map
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "session-fallback",
            cliAgentSessionHistoryHash: sha256("fallback-history"),
            volumeVersionsSnapshot: {
              versions: {}, // empty — volume not reported by runner
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const checkpoint = await findTestCheckpoint(runId);
      const snapshot = checkpoint!
        .volumeVersionsSnapshot as unknown as VolumeVersionsSnapshot;
      // Should fall back to the version specified at run time
      expect(snapshot.additionalVolumes).toEqual([
        { name: "my-vol", versionId: "v1.0", mountPath: "/mnt" },
      ]);
    });
  });

  describe("Session Resolution", () => {
    // Branch A: run already has sessionId (eager creation path)
    it("should bind conversation to the pre-created session", async () => {
      // testRunId was created via createTestRun in beforeEach — the eager path
      // already populated session_id on that run.
      const runBefore = await findTestRunRecord(testRunId);
      expect(runBefore?.sessionId).toBeTruthy();
      const preCreatedSessionId = runBefore!.sessionId!;

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "branch-a-session",
            cliAgentSessionHistoryHash: sha256("branch-a"),
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agentSessionId: string;
        conversationId: string;
      };

      // Webhook returns the same session id that was pre-created
      expect(body.agentSessionId).toBe(preCreatedSessionId);

      // Session now references the new conversation
      const session =
        await getTestAgentSessionWithConversation(preCreatedSessionId);
      expect(session?.conversationId).toBe(body.conversationId);

      // run.sessionId unchanged
      const runAfter = await findTestRunRecord(testRunId);
      expect(runAfter?.sessionId).toBe(preCreatedSessionId);
    });

    // Branch B: legacy continuation pre-deploy — continuedFromSessionId set, sessionId unset.
    // TODO(#10324): Remove this test together with checkpoint-service Branch B.
    // Skipped because agent_runs.session_id is now NOT NULL; the legacy
    // null-sessionId state this test reproduces is no longer reachable after
    // issue #10323 tightened the schema. Branch B code still exists as dead
    // code pending the follow-up cleanup PR.
    it.skip("should reuse continuedFromSessionId for legacy continuation runs", async () => {
      // Pre-create a session and seed a run that continues from it WITHOUT
      // populating sessionId (simulates an in-flight continuation at deploy time).
      const priorSession = await createTestAgentSession(
        user.userId,
        testComposeId,
      );
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
        continuedFromSessionId: priorSession.id,
      });

      const runBefore = await findTestRunRecord(runId);
      expect(runBefore?.sessionId).toBeNull();
      expect(runBefore?.continuedFromSessionId).toBe(priorSession.id);

      const token = await createTestSandboxToken(user.userId, runId);
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "branch-b-session",
            cliAgentSessionHistoryHash: sha256("branch-b"),
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agentSessionId: string;
        conversationId: string;
      };

      expect(body.agentSessionId).toBe(priorSession.id);

      const session = await getTestAgentSessionWithConversation(
        priorSession.id,
      );
      expect(session?.conversationId).toBe(body.conversationId);
    });

    // Branch C: legacy first-run pre-deploy — neither sessionId nor continuedFromSessionId set.
    // TODO(#10324): Remove this test together with checkpoint-service Branch C.
    // Skipped because agent_runs.session_id is now NOT NULL; the legacy
    // null-sessionId state this test reproduces is no longer reachable after
    // issue #10323 tightened the schema. Branch C code still exists as dead
    // code pending the follow-up cleanup PR.
    it.skip("should create a new session and backfill run.sessionId", async () => {
      const { runId } = await seedTestRun(user.userId, testComposeId, {
        status: "running",
      });

      const runBefore = await findTestRunRecord(runId);
      expect(runBefore?.sessionId).toBeNull();
      expect(runBefore?.continuedFromSessionId).toBeNull();

      const token = await createTestSandboxToken(user.userId, runId);
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/checkpoints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: "branch-c-session",
            cliAgentSessionHistoryHash: sha256("branch-c"),
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agentSessionId: string;
        conversationId: string;
      };

      expect(body.agentSessionId).toBeTruthy();

      // Run.sessionId was backfilled to the newly created session
      const runAfter = await findTestRunRecord(runId);
      expect(runAfter?.sessionId).toBe(body.agentSessionId);

      const session = await getTestAgentSessionWithConversation(
        body.agentSessionId,
      );
      expect(session?.conversationId).toBe(body.conversationId);
    });
  });
});
