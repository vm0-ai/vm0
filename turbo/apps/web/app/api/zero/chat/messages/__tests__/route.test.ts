import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  getTestZeroAgentId,
  insertOrgDefaultModelProvider,
  findTestCallbacksByRunId,
  getTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { reloadEnv } from "../../../../../../src/env";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const context = testContext();

const URL = "http://localhost:3000/api/zero/chat/messages";

describe("POST /api/zero/chat/messages", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 without auth", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "some-agent-id",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(401);
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
          agentId: "some-agent-id",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  describe("with authenticated user", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const compose = await createTestCompose(uniqueId("chat-msg"));
      agentId = await getTestZeroAgentId(user.orgId, compose.name);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
    });

    it("should return 404 for non-existent agentId", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: "00000000-0000-0000-0000-000000000000",
            prompt: "hello",
          }),
        }),
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toBe("Agent not found");
    });

    it("should create a new thread when threadId is omitted", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "hello world",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.runId).toBeTruthy();
      expect(data.threadId).toBeTruthy();
      expect(data.createdAt).toBeTruthy();
    });

    it("should reuse existing thread when threadId is provided", async () => {
      // First create a thread via the unified endpoint
      const firstResponse = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "first message",
          }),
        }),
      );
      expect(firstResponse.status).toBe(201);
      const firstData = await firstResponse.json();
      const threadId = firstData.threadId;

      // Send second message to same thread
      const secondResponse = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "second message",
            threadId,
          }),
        }),
      );

      expect(secondResponse.status).toBe(201);
      const secondData = await secondResponse.json();
      expect(secondData.threadId).toBe(threadId);
      expect(secondData.runId).not.toBe(firstData.runId);
    });

    it("should return 404 for non-existent threadId", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "hello",
            threadId: "00000000-0000-0000-0000-000000000000",
          }),
        }),
      );

      expect(response.status).toBe(404);
    });

    it("should associate run with thread via GET thread detail", async () => {
      // Import the thread detail handler to verify association
      const { GET } = await import("../../../chat-threads/[id]/route");

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "test association",
          }),
        }),
      );
      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify the run is visible in thread detail (unsavedRuns for active runs)
      const threadResponse = await GET(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads/${data.threadId}`,
          { method: "GET" },
        ),
      );
      expect(threadResponse.status).toBe(200);
      const threadData = await threadResponse.json();
      const allRunIds = threadData.unsavedRuns.map((r: { runId: string }) => {
        return r.runId;
      });
      expect(allRunIds).toContain(data.runId);
    });

    it("should register a chat callback", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "test callback",
          }),
        }),
      );
      expect(response.status).toBe(201);
      const data = await response.json();

      // Flush deferred after() callbacks (callback registration is deferred)
      await context.mocks.flushAfter();

      // Verify callback registration using test helper
      const callbacks = await findTestCallbacksByRunId(data.runId);
      expect(callbacks.length).toBeGreaterThan(0);
      expect(callbacks[0]!.url).toContain("/api/internal/callbacks/chat");
    });

    it("should include web integration prompt in appendSystemPrompt", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "test web integration prompt",
          }),
        }),
      );
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await getTestRun(data.runId);
      expect(run.appendSystemPrompt).toContain(
        "You are currently running inside: Web",
      );
      expect(run.appendSystemPrompt).toContain("web chat UI");
    });

    it("should skip title generation when hasTextContent is false (image-only message)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();

      const openRouterHandler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [{ message: { content: "Generated Title" } }],
        });
      });
      server.use(openRouterHandler.handler);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "[Attached file: photo.png](https://example.com/photo.png)",
            hasTextContent: false,
          }),
        }),
      );
      expect(response.status).toBe(201);

      await context.mocks.flushAfter();

      expect(openRouterHandler.mocked).not.toHaveBeenCalled();
    });

    it("should generate title when hasTextContent is true (text message)", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();

      const openRouterHandler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [{ message: { content: "Project Help" } }],
        });
      });
      server.use(openRouterHandler.handler);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "Help me set up my project",
            hasTextContent: true,
          }),
        }),
      );
      expect(response.status).toBe(201);

      await context.mocks.flushAfter();

      expect(openRouterHandler.mocked).toHaveBeenCalledTimes(1);
    });
  });
});
