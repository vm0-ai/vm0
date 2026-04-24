import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { clerkClient } from "@clerk/nextjs/server";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgDefaultModelProvider,
  findTestCallbacksByRunId,
  getTestRun,
  getTestChatMessagesByThread,
  countUserRows,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  getTestChatThreadModelOverride,
  getTestModelProviderIdByType,
} from "../../../../../../src/__tests__/db-test-assertions/org";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { reloadEnv } from "../../../../../../src/env";
import { server } from "../../../../../../src/mocks/server";
import * as axiomClient from "../../../../../../src/lib/shared/axiom/client";
import { http } from "../../../../../../src/__tests__/msw";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { createQueryCounter } from "../../../../../../src/__tests__/db-query-counter";
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
    const token = await generateSandboxToken("user-1", "run-1", "org-test");

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

    describe("Phase-1 sandbox-op-log web-chat instrumentation", () => {
      it("emits spans for key Phase-1 stages with dimensions stamped progressively", async () => {
        // Spy on ingestSandboxOpLog at the module boundary. The chat spans
        // reuse this single dataset with `source: "web-chat"`; filtering the
        // spy's calls by source isolates chat spans from the run-dispatch
        // `source: "web"` spans that also flow through it.
        const spanSpy = vi
          .spyOn(axiomClient, "ingestSandboxOpLog")
          .mockImplementation(() => {
            return;
          });

        try {
          const response = await POST(
            createTestRequest(URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                prompt: "hello span test",
              }),
            }),
          );
          expect(response.status).toBe(201);
          const data = await response.json();

          expect(spanSpy).toHaveBeenCalled();
          const chatSpanEvents = spanSpy.mock.calls
            .map((c) => {
              return c[0];
            })
            .filter((e) => {
              return e.source === "web-chat";
            });
          expect(chatSpanEvents.length).toBeGreaterThan(0);
          const opTypes = new Set(
            chatSpanEvents.map((e) => {
              return e.op_type;
            }),
          );

          // Key anchors from entry, Round 1, Round 4, and post-insert.
          expect(opTypes.has("api_chat_send_auth")).toBe(true);
          expect(opTypes.has("api_chat_send_agent_lookup")).toBe(true);
          expect(
            opTypes.has("api_chat_send_resolve_thread_create_thread"),
          ).toBe(true);
          expect(opTypes.has("api_chat_send_create_run_round1_agent")).toBe(
            true,
          );
          expect(
            opTypes.has("api_chat_send_create_run_insert_run_record"),
          ).toBe(true);
          expect(opTypes.has("api_chat_send_persist_zero_run_metadata")).toBe(
            true,
          );
          expect(opTypes.has("api_chat_send_insert_chat_message_insert")).toBe(
            true,
          );

          // Every chat span should carry duration_ms, sandbox_type="chat",
          // and the static agent_id dim.
          for (const event of chatSpanEvents) {
            expect(typeof event.duration_ms).toBe("number");
            expect(event.sandbox_type).toBe("chat");
            expect(event.agent_id).toBe(agentId);
          }

          // org_id is stamped after Round 1 finishes — Round 1 spans emit
          // without it, Round 2+ spans carry it.
          const round2ConnectorsSpan = chatSpanEvents.find((e) => {
            return e.op_type === "api_chat_send_create_run_round2_connectors";
          });
          expect(round2ConnectorsSpan?.org_id).toBeTruthy();

          // run_id is stamped after the tx commits — only post-commit spans
          // carry it.
          const persistSpan = chatSpanEvents.find((e) => {
            return e.op_type === "api_chat_send_persist_zero_run_metadata";
          });
          expect(persistSpan?.run_id).toBe(data.runId);

          // insert_run_record happens inside the tx, before commit — emits
          // with run_id absent.
          const insertRunRecordSpan = chatSpanEvents.find((e) => {
            return e.op_type === "api_chat_send_create_run_insert_run_record";
          });
          expect(insertRunRecordSpan?.run_id).toBeUndefined();
        } finally {
          // Restore so the spy does not leak across tests in the same suite.
          spanSpy.mockRestore();
        }
      });
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

    it("should resolve attach files to permanent /f/ URLs in thread detail", async () => {
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
      expect(userMsg.attachFiles[0].url).toBe(
        `http://localhost:3000/f/${encodeURIComponent(user.userId)}/resolve-uuid-1/data.csv`,
      );
    });

    // Two `org_metadata` SELECTs remain per POST after this dedup (Round 2
    // tier via getOrgMetadata + Round 3 credits via checkOrgCredits). Dedup
    // target is the duplicate `resolveOrg ↔ Round 2` pair in the
    // modelSelection branch (3→2) plus the `zero_agents` pair on every POST
    // (2→1). The checkOrgCredits read is a separate credits-admission path
    // tracked as a follow-up (out of scope for #10594).
    describe("deduplicates per-request reads", () => {
      it("reads zero_agents once and org_metadata twice without modelSelection", async () => {
        const counter = createQueryCounter();
        try {
          const response = await POST(
            createTestRequest(URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                prompt: "dedup without modelSelection",
              }),
            }),
          );

          expect(response.status).toBe(201);
          expect(counter.countMatching(/from\s+"?zero_agents"?/i)).toBe(1);
          expect(counter.countMatching(/from\s+"?org_metadata"?/i)).toBe(2);
        } finally {
          counter.restore();
        }
      });

      it("reads zero_agents once and org_metadata twice with modelSelection (duplicate pair eliminated)", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        const counter = createQueryCounter();
        try {
          const response = await POST(
            createTestRequest(URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                prompt: "dedup with modelSelection",
                modelSelection: {
                  modelProviderId: providerId,
                  selectedModel: "claude-opus-4-7",
                },
              }),
            }),
          );

          expect(response.status).toBe(201);
          expect(counter.countMatching(/from\s+"?zero_agents"?/i)).toBe(1);
          // 3→2: resolveOrg still reads org_metadata for tier+credits, Round 3
          // checkOrgCredits reads credits; Round 2 now hits the preload path
          // built from resolveOrg's already-fetched tier (the eliminated dup).
          expect(counter.countMatching(/from\s+"?org_metadata"?/i)).toBe(2);
        } finally {
          counter.restore();
        }
      });
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

      it("rejects modelSelection change on an existing thread", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );

        // Seed a thread with stored values on its first send.
        const first = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "first",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId } = await first.json();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "switch model",
              threadId,
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-sonnet-4-6",
              },
            }),
          }),
        );
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error.code).toBe("BAD_REQUEST");
      });

      it("allows modelSelection on existing thread when values match stored", async () => {
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
              prompt: "first",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId } = await first.json();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "follow up",
              threadId,
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(response.status).toBe(201);
      });

      it("rejects modelSelection that clears (null) on an existing thread with stored values", async () => {
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
              prompt: "first",
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId } = await first.json();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "reset",
              threadId,
              modelSelection: null,
            }),
          }),
        );
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error.code).toBe("BAD_REQUEST");
      });

      it("accepts first modelSelection on a freshly-created thread", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );

        // Create a thread with no modelSelection — stored values remain null.
        const create = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "greet",
            }),
          }),
        );
        expect(create.status).toBe(201);
        const { threadId } = await create.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBeNull();
        expect(override.selectedModel).toBeNull();

        // First modelSelection on this thread must be accepted.
        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "with override",
              threadId,
              modelSelection: {
                modelProviderId: providerId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );
        expect(response.status).toBe(201);
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

    describe("user info source", () => {
      it("short-circuits getCachedUser when sessionClaims carry email + name", async () => {
        const email = `${user.userId}@claims.example.com`;
        mockClerk({
          userId: user.userId,
          email,
          firstName: "Ada",
          lastName: "Lovelace",
          sessionClaims: {
            email,
            first_name: "Ada",
            last_name: "Lovelace",
          },
        });
        const client = await clerkClient();
        vi.mocked(client.users.getUser).mockClear();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "claims fast path" }),
          }),
        );

        expect(response.status).toBe(201);
        const data = await response.json();

        expect(client.users.getUser).not.toHaveBeenCalled();
        expect(await countUserRows("user_cache", user.userId)).toBe(0);

        const run = await getTestRun(data.runId);
        expect(run.appendSystemPrompt).toContain("Name: Ada Lovelace");
        expect(run.appendSystemPrompt).toContain(`Email: ${email}`);
      });

      it("falls back to getCachedUser when sessionClaims are empty", async () => {
        const email = `${user.userId}@fallback.example.com`;
        mockClerk({
          userId: user.userId,
          email,
          firstName: "Ada",
          lastName: null,
        });
        const client = await clerkClient();
        vi.mocked(client.users.getUser).mockClear();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "cache fallback" }),
          }),
        );

        expect(response.status).toBe(201);
        const data = await response.json();

        expect(client.users.getUser).toHaveBeenCalledWith(user.userId);

        const run = await getTestRun(data.runId);
        expect(run.appendSystemPrompt).toContain("Name: Ada");
        expect(run.appendSystemPrompt).toContain(`Email: ${email}`);
      });

      it("falls back to getCachedUser when sessionClaims.email is empty", async () => {
        const email = `${user.userId}@empty-claim.example.com`;
        mockClerk({
          userId: user.userId,
          email,
          firstName: "Ada",
          lastName: "Lovelace",
          sessionClaims: {
            email: "",
            first_name: "Ada",
            last_name: "Lovelace",
          },
        });
        const client = await clerkClient();
        vi.mocked(client.users.getUser).mockClear();

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "defensive fallback" }),
          }),
        );

        expect(response.status).toBe(201);
        expect(client.users.getUser).toHaveBeenCalledWith(user.userId);
      });
    });
  });
});
