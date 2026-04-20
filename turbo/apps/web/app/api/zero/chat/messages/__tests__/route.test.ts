import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgDefaultModelProvider,
  findTestCallbacksByRunId,
  findTestRunRecord,
  getTestRun,
  getTestChatMessagesByThread,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  getTestChatThreadModelOverride,
  getTestModelProviderIdByType,
} from "../../../../../../src/__tests__/db-test-assertions/org";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import { POST as createChatThreadPOST } from "../../../chat-threads/route";
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
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { GET as getChatThreadById } from "../../../chat-threads/[id]/route";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const context = testContext();

const URL = "http://localhost:3000/api/zero/chat/messages";

describe("POST /api/zero/chat/messages", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
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

      // Verify the thread contains the user message (no assistant placeholder
      // is inserted at send time — only the user message is appended).
      const threadResponse = await GET(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads/${data.threadId}`,
          { method: "GET" },
        ),
      );
      expect(threadResponse.status).toBe(200);
      const threadData = await threadResponse.json();
      const userMsgs = threadData.chatMessages.filter((m: { role: string }) => {
        return m.role === "user";
      });
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("test association");
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

    it("includes the schedule name in the continue-from-schedule prompt when the source run references a real schedule", async () => {
      const { createTestSchedule } =
        await import("../../../../../../src/__tests__/api-test-helpers");

      const schedule = await createTestSchedule(
        agentId,
        `sched-${crypto.randomUUID().slice(0, 8)}`,
        { prompt: "daily run" },
      );
      const { runId: sourceRunId } = await seedTestRun(user.userId, agentId, {
        status: "completed",
        scheduleId: schedule.id,
        triggerSource: "schedule",
      });

      const createThreadResponse = await createChatThreadPOST(
        createTestRequest("http://localhost:3000/api/zero/chat-threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            sourceScheduleRunId: sourceRunId,
          }),
        }),
      );
      expect(createThreadResponse.status).toBe(201);
      const { id: threadId } = await createThreadResponse.json();

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "continue from schedule",
            threadId,
          }),
        }),
      );
      expect(response.status).toBe(201);
      const { runId } = await response.json();

      const run = await findTestRunRecord(runId);
      expect(run?.appendSystemPrompt).toContain(sourceRunId);
      expect(run?.appendSystemPrompt).toContain(
        `scheduleName: ${schedule.name}`,
      );
      expect(run?.appendSystemPrompt).toContain("zero logs");
      // Web chat UI context is always still present.
      expect(run?.appendSystemPrompt).toContain(
        "You are currently running inside: Web",
      );
    });

    it("seeds the source-schedule prompt on the first run only", async () => {
      // A thread created with sourceScheduleRunId should apply a built-in
      // continue-from-schedule system prompt to the FIRST run in the thread
      // only. Subsequent runs inherit the session context and do not get the
      // prompt appended again.
      const sourceScheduleRunId = crypto.randomUUID();
      const createThreadResponse = await createChatThreadPOST(
        createTestRequest("http://localhost:3000/api/zero/chat-threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, sourceScheduleRunId }),
        }),
      );
      expect(createThreadResponse.status).toBe(201);
      const { id: threadId } = await createThreadResponse.json();

      const first = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "continue please",
            threadId,
          }),
        }),
      );
      expect(first.status).toBe(201);
      const firstData = await first.json();
      const firstRun = await findTestRunRecord(firstData.runId);
      expect(firstRun?.appendSystemPrompt).toContain(sourceScheduleRunId);
      expect(firstRun?.appendSystemPrompt).toContain("zero logs");

      const second = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "follow-up question",
            threadId,
          }),
        }),
      );
      expect(second.status).toBe(201);
      const secondData = await second.json();
      const secondRun = await findTestRunRecord(secondData.runId);
      // The composed prompt still carries the default agent tools preamble,
      // but the source-run reference must not leak into follow-up runs.
      expect(secondRun?.appendSystemPrompt ?? "").not.toContain(
        sourceScheduleRunId,
      );
      expect(secondRun?.appendSystemPrompt ?? "").not.toContain("zero logs");
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

    describe("Signal Publishing", () => {
      it("should publish chatThreadRunCreated and chatThreadMessageCreated signals after sending a message", async () => {
        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "hello signal test",
            }),
          }),
        );
        expect(response.status).toBe(201);
        const data = await response.json();

        await context.mocks.flushAfter();

        expect(mockAblyPublish).toHaveBeenCalledWith(
          `chatThreadRunCreated:${data.threadId}`,
          null,
        );
        expect(mockAblyPublish).toHaveBeenCalledWith(
          `chatThreadMessageCreated:${data.threadId}`,
          null,
        );
      });
    });

    it("should store attach file IDs in chat_messages and include attach files prompt in system prompt", async () => {
      const attachFiles = [
        {
          id: "file-uuid-1",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
        {
          id: "file-uuid-2",
          filename: "photo.png",
          contentType: "image/png",
          size: 4096,
        },
      ];

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "Check these files",
            attachFiles,
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify file IDs are persisted in chat_messages
      const messages = await getTestChatMessagesByThread(data.threadId);
      const userMsg = messages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.attachFiles).toEqual(["file-uuid-1", "file-uuid-2"]);

      // Verify file descriptions are in the prompt (not systemPrompt)
      const run = await getTestRun(data.runId);
      expect(run.appendSystemPrompt).not.toContain("Web Attached Files");
    });

    it("should resolve attach files with presigned URLs in thread detail", async () => {
      // Create a thread with a message containing attach files via the API
      const attachFiles = [
        {
          id: "resolve-uuid-1",
          filename: "data.csv",
          contentType: "text/csv",
          size: 512,
        },
      ];

      const sendResponse = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "Analyze this data",
            attachFiles,
          }),
        }),
      );
      expect(sendResponse.status).toBe(201);
      const sendData = await sendResponse.json();

      // Mock S3 to return the file for resolution
      context.mocks.s3.listS3Objects.mockImplementation(
        async (_bucket: string, prefix: string) => {
          if (prefix.includes("resolve-uuid-1")) {
            return [
              {
                key: `uploads/${user.userId}/resolve-uuid-1/data.csv`,
                size: 512,
              },
            ];
          }
          return [];
        },
      );
      context.mocks.s3.generatePresignedUrl.mockResolvedValue(
        "https://presigned-url/data.csv",
      );

      // Fetch thread detail which resolves attach files
      const threadResponse = await getChatThreadById(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads/${sendData.threadId}`,
          { method: "GET" },
        ),
      );
      expect(threadResponse.status).toBe(200);
      const threadData = await threadResponse.json();

      const userMsg = threadData.chatMessages.find((m: { role: string }) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg.attachFiles).toBeDefined();
      expect(userMsg.attachFiles).toHaveLength(1);
      expect(userMsg.attachFiles[0].id).toBe("resolve-uuid-1");
      expect(userMsg.attachFiles[0].filename).toBe("data.csv");
      expect(userMsg.attachFiles[0].url).toBe("https://presigned-url/data.csv");
    });

    describe("per-run model selection (composer picker)", () => {
      it("persists modelSelection onto the thread", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "hello with override",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(providerId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("clears the thread override when modelSelection is null", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );

        // Seed an override via the first send.
        const first = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "with override",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId } = await first.json();

        // Now clear it explicitly.
        const clear = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "reset to default",
              threadId,
              modelSelection: null,
            }),
          }),
        );
        expect(clear.status).toBe(201);

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBeNull();
        expect(override.selectedModel).toBeNull();
      });

      it("leaves the thread override untouched when modelSelection is omitted", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );

        const first = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "with override",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId } = await first.json();

        // Second send omits modelSelection — the server must keep the
        // previously-saved override instead of resetting it.
        const second = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "follow up",
              threadId,
            }),
          }),
        );
        expect(second.status).toBe(201);

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(providerId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("rejects a providerId from a different org", async () => {
        // Create a second org and set up a provider under it.
        const otherContext = testContext();
        otherContext.setupMocks();
        const other = await otherContext.setupUser();
        await insertOrgDefaultModelProvider(other.orgId, "anthropic-api-key");
        const otherProviderId = await getTestModelProviderIdByType(
          other.orgId,
          "anthropic-api-key",
        );

        // Switch back to the original user before sending.
        context.setupMocks();
        mockClerk({ userId: user.userId });

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "should be rejected",
              modelSelection: {
                modelProviderId: otherProviderId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(response.status).toBe(400);
      });
    });
  });
});
