import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSessionWithConversation,
  createTestRunInDb,
  findTestZeroRun,
  insertOrgDefaultModelProvider,
} from "../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  generateSandboxToken,
  generateZeroToken,
} from "../../../../../src/lib/auth/sandbox-token";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();

const URL = "http://localhost:3000/api/zero/runs";

describe("POST /api/zero/runs", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 403 for sandbox token without agent-run:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1");

    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: "some-compose-id",
          prompt: "test prompt",
        }),
      }),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:write");
  });

  describe("sessionId inference", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const compose = await createTestCompose(uniqueId("session-agent"));
      agentId = await getTestZeroAgentId(user.orgId, compose.name);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should infer agentId from sessionId when agentId is not provided", async () => {
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
      const session = await createTestSessionWithConversation(
        user.userId,
        agentId,
      );

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.id,
            prompt: "test delegation",
          }),
        }),
      );

      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.runId).toBeTruthy();
    });

    it("should return 403 when ZERO_TOKEN is used (agent-run:write excluded)", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: "00000000-0000-0000-0000-000000000000",
            prompt: "test prompt",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should return 400 when neither agentId nor sessionId is provided", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test prompt",
          }),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toBe("agentId is required");
    });
  });

  describe("triggerSource", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const compose = await createTestCompose(uniqueId("trigger-agent"));
      agentId = await getTestZeroAgentId(user.orgId, compose.name);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should return 403 for ZERO_TOKEN callers (agent-run:write excluded)", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId,
            prompt: "delegated task",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should set triggerSource to 'web' for Clerk JWT callers", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "web task",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      const zeroRun = await findTestZeroRun(data.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerSource).toBe("web");
    });

    it("should return 403 for ZERO_TOKEN callers even with parent run context", async () => {
      // Create a parent agent compose and a run for it (simulates the parent agent)
      // Must happen before mockClerk({ userId: null }) since createTestCompose needs auth
      const parentCompose = await createTestCompose(uniqueId("parent-agent"));
      const parentRun = await createTestRunInDb(
        user.userId,
        parentCompose.composeId,
        { status: "running" },
      );

      mockClerk({ userId: null });

      // Generate a ZERO_TOKEN as if from the parent run's sandbox
      const token = await generateZeroToken(
        user.userId,
        parentRun.runId,
        user.orgId,
      );

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId,
            prompt: "delegated from parent",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should leave triggerAgentId null for web callers", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "web task no parent",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      const zeroRun = await findTestZeroRun(data.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerAgentId).toBeNull();
    });
  });
});
