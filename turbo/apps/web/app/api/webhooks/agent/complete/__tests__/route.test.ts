import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  completeTestRun,
  createTestSchedule,
  createTestZeroAgent,
  linkRunToSchedule,
  createTestAgentSession,
  createTestEmailThreadSession,
  createTestCallback,
  findTestCallbacksByRunId,
  findTestRunRecord,
  findTestQueueEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../../src/env";
import {
  getAgentSessionWithConversation,
  getSessionChatMessages,
} from "../../../../../../src/lib/agent-session";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { POST as checkpointWebhook } from "../../checkpoints/route";
import { generateReplyToken } from "../../../../../../src/lib/email/handlers/shared";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";
import { POST as createThreadHandler } from "../../../../zero/chat-threads/route";
import { POST as addRunToThreadHandler } from "../../../../zero/chat-threads/[id]/runs/route";
import { GET as getThreadDetailHandler } from "../../../../zero/chat-threads/[id]/route";

const context = testContext();

describe("POST /api/webhooks/agent/complete", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create compose for test runs
    const { composeId } = await createTestCompose(uniqueId("complete"));
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
    it("should reject complete without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
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
    it("should reject complete without runId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject complete without exitCode", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            // exitCode: missing
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("exitCode");
    });
  });

  describe("Authorization", () => {
    it("should reject complete for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject complete for run owned by different user", async () => {
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

      // Generate token for the original user but try to complete other user's run
      const tokenWithWrongUser = await createTestSandboxToken(
        user.userId,
        otherRunId, // other user's run
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenWithWrongUser}`,
          },
          body: JSON.stringify({
            runId: otherRunId,
            exitCode: 0,
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
    it("should handle successful completion (exitCode=0)", async () => {
      // Create checkpoint first (required for successful completion)
      const checkpointRequest = createTestRequest(
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
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

      // Now complete the run
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");
    });

    it("should include memory in result when checkpoint has memorySnapshot", async () => {
      // Create checkpoint with both artifact and memory snapshots
      const checkpointRequest = createTestRequest(
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
            cliAgentSessionId: "test-session-mem",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "v1",
            },
            memorySnapshot: {
              memoryName: "my-memory",
              memoryVersion: "mem-v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

      // Complete the run
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify run result includes memory
      const run = await findTestRunRecord(testRunId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("completed");

      const result = run!.result as {
        memory?: Record<string, string>;
        artifact?: Record<string, string>;
      };
      expect(result.memory).toEqual({ "my-memory": "mem-v1" });
      expect(result.artifact).toEqual({ "test-artifact": "v1" });
    });

    it("should store memoryName in agent session when checkpoint has memorySnapshot", async () => {
      // Create checkpoint with memorySnapshot
      const checkpointRequest = createTestRequest(
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
            cliAgentSessionId: "test-session-mem-store",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            memorySnapshot: {
              memoryName: "persist-memory",
              memoryVersion: "mem-v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);

      const checkpointData = (await checkpointResponse.json()) as {
        agentSessionId: string;
      };

      // Verify agent session has memoryName
      const session = await getAgentSessionWithConversation(
        checkpointData.agentSessionId,
      );
      expect(session).toBeDefined();
      expect(session!.memoryName).toBe("persist-memory");
    });

    it("should handle failed completion (exitCode≠0)", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });

    it("should use default error message when exitCode≠0 and no error provided", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 127,
            // no error provided
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });
  });

  describe("Chat Persistence", () => {
    it("should persist chat messages to session after successful completion", async () => {
      // Create checkpoint (which creates a session)
      const checkpointRequest = createTestRequest(
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
            cliAgentSessionId: "test-session-chat",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);
      const checkpointData = (await checkpointResponse.json()) as {
        agentSessionId: string;
      };

      // Mock Axiom to return a result event for this run
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventData: { result: "Here is the agent response." },
        },
      ]);

      // Complete the run
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush after() callbacks which trigger persistChatMessages
      await context.mocks.flushAfter();

      // Verify session now has chat messages
      type StoredMessage = { role: string; content: string; runId?: string };
      const chatMessages = (await getSessionChatMessages(
        checkpointData.agentSessionId,
      )) as StoredMessage[];
      expect(chatMessages.length).toBeGreaterThanOrEqual(2);

      // Verify user message from prompt
      const userMsg = chatMessages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("Test prompt");

      // Verify assistant message from Axiom result
      const assistantMsg = chatMessages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("Here is the agent response.");
      expect(assistantMsg!.runId).toBe(testRunId);
    });

    it("should persist only user message when no result found in Axiom", async () => {
      // Create checkpoint
      const checkpointRequest = createTestRequest(
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
            cliAgentSessionId: "test-session-no-result",
            cliAgentSessionHistory: JSON.stringify({ type: "test" }),
            artifactSnapshot: {
              artifactName: "test-artifact",
              artifactVersion: "v1",
            },
          }),
        },
      );
      const checkpointResponse = await checkpointWebhook(checkpointRequest);
      expect(checkpointResponse.status).toBe(200);
      const checkpointData = (await checkpointResponse.json()) as {
        agentSessionId: string;
      };

      // Axiom returns no events (default mock)
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      // Complete the run
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Verify session has only user message
      type StoredMessage = { role: string; content: string };
      const chatMessages = (await getSessionChatMessages(
        checkpointData.agentSessionId,
      )) as StoredMessage[];
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0]!.role).toBe("user");
      expect(chatMessages[0]!.content).toBe("Test prompt");
    });
  });

  describe("Title Regeneration", () => {
    /**
     * Helper: fetch a thread's title via the GET /api/zero/chat-threads/:id endpoint.
     * Temporarily switches Clerk mock to the given userId, then restores null.
     */
    async function getThreadTitle(
      threadId: string,
      userId: string,
    ): Promise<string | null> {
      mockClerk({ userId });
      const res = await getThreadDetailHandler(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        ),
      );
      mockClerk({ userId: null });
      const data = (await res.json()) as { title: string | null };
      return data.title;
    }

    /**
     * Helper: create a chat thread, link a run to it, and return the thread ID.
     * Requires the caller to have mockClerk set to the correct user first.
     */
    async function createThreadAndLinkRun(
      composeId: string,
      runId: string,
    ): Promise<string> {
      const createRes = await createThreadHandler(
        createTestRequest("http://localhost:3000/api/zero/chat-threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: composeId,
            title: "Initial title",
          }),
        }),
      );
      const { id: threadId } = (await createRes.json()) as { id: string };

      await addRunToThreadHandler(
        createTestRequest(
          `http://localhost:3000/api/zero/chat-threads/${threadId}/runs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId }),
          },
        ),
      );

      return threadId;
    }

    /**
     * Set up MSW handler for OpenRouter that returns a generated title.
     */
    function mockOpenRouter(title: string) {
      const { handler, mocked } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        () =>
          HttpResponse.json({
            choices: [{ message: { content: title } }],
          }),
      );
      server.use(handler);
      return mocked;
    }

    /**
     * Set up MSW handler for OpenRouter that returns an error.
     */
    function mockOpenRouterError(status: number) {
      const { handler, mocked } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        () => new HttpResponse("Internal Server Error", { status }),
      );
      server.use(handler);
      return mocked;
    }

    it("should regenerate thread title after successful completion", async () => {
      // Set up: user, compose, run, checkpoint, thread
      const titleUser = await context.setupUser({ prefix: "title-regen" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("title-agent"));
      const { runId } = await createTestRun(composeId, "How do I debug Node?");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      const threadId = await createThreadAndLinkRun(composeId, runId);

      // Create checkpoint
      mockClerk({ userId: null });
      const checkpointRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "title-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(checkpointRes.status).toBe(200);

      // Mock Axiom to return an assistant result
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Use --inspect flag for debugging." } },
      ]);

      // Mock OpenRouter to return a generated title
      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      const openRouterMock = mockOpenRouter("Debugging Node.js Apps");

      // Complete the run
      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);

      // Flush after() callbacks (chat persistence + title regeneration)
      await context.mocks.flushAfter();

      // Verify OpenRouter was called
      expect(openRouterMock).toHaveBeenCalledTimes(1);

      // Verify thread title was updated via the API
      const title = await getThreadTitle(threadId, titleUser.userId);
      expect(title).toBe("Debugging Node.js Apps");
    });

    it("should pass both prompt and assistant result to OpenRouter", async () => {
      const titleUser = await context.setupUser({ prefix: "title-body" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("body-agent"));
      const { runId } = await createTestRun(composeId, "Fix my CSS layout");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      await createThreadAndLinkRun(composeId, runId);

      mockClerk({ userId: null });
      const cpRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "body-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(cpRes.status).toBe(200);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Use flexbox for centering" } },
      ]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();

      // Capture the request body sent to OpenRouter
      let capturedBody: {
        messages: Array<{ role: string; content: string }>;
      } | null = null;
      const { handler } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({
            choices: [{ message: { content: "CSS Flexbox Layout Fix" } }],
          });
        },
      );
      server.use(handler);

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Verify both user prompt and assistant result were sent
      expect(capturedBody).not.toBeNull();
      const messages = capturedBody!.messages;
      expect(messages).toHaveLength(3); // system + user + assistant
      expect(messages[0]!.role).toBe("system");
      expect(messages[1]!.role).toBe("user");
      expect(messages[1]!.content).toBe("Fix my CSS layout");
      expect(messages[2]!.role).toBe("assistant");
      expect(messages[2]!.content).toBe("Use flexbox for centering");
    });

    it("should not regenerate title when run has no linked thread", async () => {
      // Create checkpoint without linking to a thread
      const checkpointRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "no-thread-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(checkpointRes.status).toBe(200);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      const openRouterMock = mockOpenRouter("Should not be called");

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // OpenRouter should NOT have been called (no thread linked)
      expect(openRouterMock).not.toHaveBeenCalled();
    });

    it("should skip title generation when OPENROUTER_API_KEY is not set", async () => {
      const titleUser = await context.setupUser({ prefix: "title-nokey" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("nokey-agent"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      const threadId = await createThreadAndLinkRun(composeId, runId);

      mockClerk({ userId: null });
      const cpRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "nokey-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(cpRes.status).toBe(200);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Some result" } },
      ]);

      // Do NOT set OPENROUTER_API_KEY — feature should be a no-op

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Thread title should remain as initial value (not regenerated)
      const title = await getThreadTitle(threadId, titleUser.userId);
      expect(title).toBe("Initial title");
    });

    it("should not fail completion when OpenRouter returns an error", async () => {
      const titleUser = await context.setupUser({ prefix: "title-err" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("err-agent"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      const threadId = await createThreadAndLinkRun(composeId, runId);

      mockClerk({ userId: null });
      const cpRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "err-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(cpRes.status).toBe(200);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventData: { result: "Some result" } },
      ]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      mockOpenRouterError(500);

      // Completion should still succeed even though title generation fails
      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);

      // Should not throw — title error is caught and logged
      await context.mocks.flushAfter();

      // Thread title should remain unchanged (error was swallowed)
      const title = await getThreadTitle(threadId, titleUser.userId);
      expect(title).toBe("Initial title");
    });

    it("should not regenerate title on failed completion", async () => {
      const titleUser = await context.setupUser({ prefix: "title-fail" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("fail-agent"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      await createThreadAndLinkRun(composeId, runId);

      mockClerk({ userId: null });

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      const openRouterMock = mockOpenRouter("Should not be called");

      // Fail the run (exitCode ≠ 0, no checkpoint needed)
      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        }),
      );
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Title regeneration only happens on success — OpenRouter should not be called
      expect(openRouterMock).not.toHaveBeenCalled();
    });

    it("should regenerate title with only prompt when Axiom returns no result", async () => {
      const titleUser = await context.setupUser({ prefix: "title-noresult" });
      mockClerk({ userId: titleUser.userId });
      const { composeId } = await createTestCompose(uniqueId("noresult-agent"));
      const { runId } = await createTestRun(composeId, "Deploy to production");
      const token = await createTestSandboxToken(titleUser.userId, runId);
      const threadId = await createThreadAndLinkRun(composeId, runId);

      mockClerk({ userId: null });
      const cpRes = await checkpointWebhook(
        createTestRequest(
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
              cliAgentSessionId: "noresult-session",
              cliAgentSessionHistory: JSON.stringify({ type: "test" }),
              artifactSnapshot: {
                artifactName: "test-artifact",
                artifactVersion: "v1",
              },
            }),
          },
        ),
      );
      expect(cpRes.status).toBe(200);

      // Axiom returns no result
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();

      let capturedBody: {
        messages: Array<{ role: string; content: string }>;
      } | null = null;
      const { handler } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({
            choices: [{ message: { content: "Production Deployment" } }],
          });
        },
      );
      server.use(handler);

      const response = await POST(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runId, exitCode: 0 }),
        }),
      );
      expect(response.status).toBe(200);
      await context.mocks.flushAfter();

      // Only system + user messages (no assistant since Axiom returned nothing)
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.messages).toHaveLength(2);
      expect(capturedBody!.messages[1]!.role).toBe("user");
      expect(capturedBody!.messages[1]!.content).toBe("Deploy to production");

      // Title should be updated
      const title = await getThreadTitle(threadId, titleUser.userId);
      expect(title).toBe("Production Deployment");
    });
  });

  describe("Error Handling", () => {
    it("should return 404 when checkpoint not found for successful run", async () => {
      // Don't create checkpoint - complete should fail
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Checkpoint");
    });
  });

  describe("Idempotency", () => {
    it("should return success without processing for already completed run", async () => {
      // Complete the run first using the helper
      await completeTestRun(user.userId, testRunId);

      // Try to complete again
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 0,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("completed");
    });

    it("should return success without processing for already failed run", async () => {
      // Fail the run first
      const failRequest = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Initial failure",
          }),
        },
      );

      const failResponse = await POST(failRequest);
      expect(failResponse.status).toBe(200);

      // Try to complete again with different exit code
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Another error",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("failed");
    });
  });

  describe("Callback Dispatch", () => {
    it("should dispatch registered callbacks on run completion", async () => {
      // Register a callback for this run
      await createTestCallback({
        runId: testRunId,
        url: "http://localhost/api/internal/callbacks/test",
        payload: { testKey: "testValue" },
      });

      // When the run fails (simpler, no checkpoint needed)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback (dispatchCallbacks)
      await context.mocks.flushAfter();

      // Verify the callback was attempted (status should be updated)
      const callbacks = await findTestCallbacksByRunId(testRunId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.attempts).toBe(1);
    });

    it("should register only one after() callback for dispatch", async () => {
      // When a non-scheduled run completes (testRunId has no callbacks)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Some error",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Only one after() callback: dispatchCallbacks
      expect(globalThis.nextAfterCallbacks).toHaveLength(1);
      await context.mocks.flushAfter();
    });

    it("should not send notifications for non-scheduled runs without callbacks", async () => {
      const mockResend = vi.mocked(new Resend(""), true);
      mockResend.emails.send.mockClear();

      // When a normal run completes (no callbacks registered)
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            exitCode: 1,
            error: "Some error",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // No email should be sent (no callbacks registered)
      expect(mockResend.emails.send).not.toHaveBeenCalled();
    });

    it("should dispatch email reply callback when registered", async () => {
      // Set up an email reply callback
      const emailUser = await context.setupUser({ prefix: "email-cb" });
      mockClerk({ userId: emailUser.userId });
      const { composeId, agentId } = await createTestCompose(
        uniqueId("reply-agent"),
      );
      const agentSession = await createTestAgentSession(
        emailUser.userId,
        composeId,
      );
      const replyToken = generateReplyToken(agentSession.id);

      const emailSession = await createTestEmailThreadSession({
        userId: emailUser.userId,
        agentId,
        agentSessionId: agentSession.id,
        replyToToken: replyToken,
        lastEmailMessageId: "<original-msg-id@vm7.bot>",
      });

      const { runId } = await createTestRun(composeId, "Email reply task");

      // Register a callback (as the inbound-reply handler now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: {
          emailThreadSessionId: emailSession.id,
          inboundEmailId: "inbound-email-456",
        },
      });

      const token = await createTestSandboxToken(emailUser.userId, runId);
      mockClerk({ userId: null });

      // When the run fails
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Verify the callback was dispatched (attempted)
      const callbacks = await findTestCallbacksByRunId(runId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.attempts).toBe(1);
    });

    it("should drain queued run after completion", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Use a separate user to avoid concurrency interference
      const qUser = await context.setupUser({ prefix: "queue-drain" });
      mockClerk({ userId: qUser.userId });
      const { composeId } = await createTestCompose(uniqueId("drain-agent"));

      // First run claims the slot
      const run1 = await createTestRun(composeId, "First run");
      expect(run1.status).toBe("pending");

      // Second run gets queued
      const run2 = await createTestRun(composeId, "Queued run");
      expect(run2.status).toBe("queued");

      // Verify queue entry exists
      const queueBefore = await findTestQueueEntry(run2.runId);
      expect(queueBefore).toBeDefined();

      // Complete the first run via webhook
      const token = await createTestSandboxToken(qUser.userId, run1.runId);
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId: run1.runId,
            exitCode: 1,
            error: "Done",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback which triggers drainOrgQueue
      await context.mocks.flushAfter();

      // Queued run should now be dispatched (pending)
      const run2After = await findTestRunRecord(run2.runId);
      expect(run2After!.status).toBe("pending");

      // Queue entry should be deleted
      const queueAfter = await findTestQueueEntry(run2.runId);
      expect(queueAfter).toBeUndefined();
    });

    it("should dispatch schedule callbacks when registered", async () => {
      // Use a separate user for concurrency
      const schedUser = await context.setupUser({ prefix: "sched-cb" });
      mockClerk({ userId: schedUser.userId });
      const agentName = uniqueId("sched-agent");
      const { composeId } = await createTestCompose(agentName);
      await createTestZeroAgent(schedUser.orgId, agentName, {});
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Scheduled task");
      await linkRunToSchedule(runId, schedule.id);

      // Register callbacks (as executeSchedule now does)
      await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/schedule",
        payload: {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          agentName,
          userId: schedUser.userId,
        },
      });
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
        payload: {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          agentName,
          userId: schedUser.userId,
        },
      });

      const token = await createTestSandboxToken(schedUser.userId, runId);
      mockClerk({ userId: null });

      // When the run fails
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/complete",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId,
            exitCode: 1,
            error: "Agent crashed",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      // Verify both callbacks were dispatched (attempted)
      const callbacks = await findTestCallbacksByRunId(runId);
      expect(callbacks).toHaveLength(2);
      expect(callbacks.every((c) => c.attempts === 1)).toBe(true);
    });
  });
});
