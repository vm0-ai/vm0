import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { clerkClient } from "@clerk/nextjs/server";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgDefaultModelProvider,
  insertOrgNonDefaultModelProvider,
  insertUserDefaultModelProvider,
  enablePersonalModelProviderForUser,
  deleteTestModelProvider,
  setTestZeroAgentModelProvider,
  setOrgCredits,
  findTestCallbacksByRunId,
  findTestRunnerJobEntry,
  getTestRun,
  getTestChatMessagesByThread,
  countUserRows,
  completeTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  setTestSessionFramework,
  setTestZeroAgentPreferPersonalProvider,
} from "../../../../../../src/__tests__/db-test-seeders/agents";
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

    it("should create a new thread with the provided clientThreadId", async () => {
      const clientThreadId = crypto.randomUUID();
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "hello world",
            clientThreadId,
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.threadId).toBe(clientThreadId);
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

      // insertChatMessage is deferred into after() — drain it before reading
      // the thread detail so the user message row is visible.
      await context.mocks.flushAfter();

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

          // The insert_chat_message span is emitted inside after() now —
          // drain the queue before reading spy calls.
          await context.mocks.flushAfter();

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

          // run_id is stamped after agent_runs insert returns; spans emitted
          // after that point carry it even while still inside the tx.
          const persistSpan = chatSpanEvents.find((e) => {
            return e.op_type === "api_chat_send_persist_zero_run_metadata";
          });
          expect(persistSpan?.run_id).toBe(data.runId);

          // insert_run_record emits before the inserted run id is stamped.
          const insertRunRecordSpan = chatSpanEvents.find((e) => {
            return e.op_type === "api_chat_send_create_run_insert_run_record";
          });
          expect(insertRunRecordSpan?.run_id).toBeUndefined();
        } finally {
          // Restore so the spy does not leak across tests in the same suite.
          spanSpy.mockRestore();
        }
      });

      it("emits the 3-way diagnostic split for the callbacks+token phase", async () => {
        // Spans below are source="web" (recordSandboxOperation), not web-chat.
        // They are emitted by buildAndDispatchRun inside the after() callback
        // so the spy must survive until flushAfter() drains the queue.
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
                prompt: "hello phase-2 split test",
              }),
            }),
          );
          expect(response.status).toBe(201);

          // Phase-2 spans are emitted inside the after() callback.
          await context.mocks.flushAfter();

          const dispatchSpans = spanSpy.mock.calls
            .map((c) => {
              return c[0];
            })
            .filter((e) => {
              return e.source === "web";
            });

          const byOp = new Map(
            dispatchSpans.map((e) => {
              return [e.op_type, e];
            }),
          );

          // Three-way split — only emitted when the chat route stamped both
          // responseReady (via markResponseReady) and dispatchStart.
          expect(byOp.has("api_phase1_post_tx_sync")).toBe(true);
          expect(byOp.has("api_after_scheduling_gap")).toBe(true);
          expect(byOp.has("api_phase2_callbacks_token_pure")).toBe(true);

          // Further split of api_after_scheduling_gap — only emitted when the
          // after() closure in zero-run-service.ts stamped afterEnterAt.
          expect(byOp.has("api_after_schedule_to_closure")).toBe(true);
          expect(byOp.has("api_after_closure_to_dispatch")).toBe(true);

          // The signals-path after() callback emits its own closure-entry
          // offset against the same responseReady anchor.
          expect(byOp.has("api_after_signals_enter_offset")).toBe(true);

          const phase1 = byOp.get("api_phase1_post_tx_sync")!;
          const gap = byOp.get("api_after_scheduling_gap")!;
          const phase2 = byOp.get("api_phase2_callbacks_token_pure")!;
          const scheduleToClosure = byOp.get("api_after_schedule_to_closure")!;
          const closureToDispatch = byOp.get("api_after_closure_to_dispatch")!;
          const signalsOffset = byOp.get("api_after_signals_enter_offset")!;

          for (const span of [
            phase1,
            gap,
            phase2,
            scheduleToClosure,
            closureToDispatch,
            signalsOffset,
          ]) {
            expect(typeof span.duration_ms).toBe("number");
            expect(span.duration_ms).toBeGreaterThanOrEqual(0);
          }

          // The two closure-entry subspans sum to api_after_scheduling_gap
          // within same-process jitter.
          const gapSum =
            scheduleToClosure.duration_ms + closureToDispatch.duration_ms;
          expect(Math.abs(gapSum - gap.duration_ms)).toBeLessThanOrEqual(10);
        } finally {
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

      // insertChatMessage is deferred into after() — drain before reading.
      await context.mocks.flushAfter();

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

      // insertChatMessage is deferred into after() — drain before reading.
      await context.mocks.flushAfter();

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
        `http://localhost:3000/f/${encodeURIComponent(user.userId.replace(/^user_/, ""))}/resolve-uuid-1/data.csv`,
      );
    });

    // One `org_metadata` SELECT per POST: the `resolveOrg` tier+credits read.
    // The credits-admission path (checkOrgCreditsForRunAdmission) only touches
    // org_metadata on the vm0 branch; BYOK and default-non-vm0 paths
    // short-circuit before the balance check (#10951).
    describe("deduplicates per-request reads", () => {
      it("reads zero_agents once and org_metadata once without modelSelection", async () => {
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
          expect(counter.countMatching(/from\s+"?org_metadata"?/i)).toBe(1);
        } finally {
          counter.restore();
        }
      });

      it("reads zero_agents once and org_metadata once with modelSelection (BYOK fast-exit)", async () => {
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
          // The modelSelection resolves to a BYOK provider, so credit admission
          // fast-exits — no org_metadata read from credits admission. Round 2
          // uses resolveOrg's preloaded tier (the eliminated dup from #10594).
          expect(counter.countMatching(/from\s+"?org_metadata"?/i)).toBe(1);
        } finally {
          counter.restore();
        }
      });

      it("reads zero_agents once and org_metadata once for vm0-managed credit admission", async () => {
        await insertOrgDefaultModelProvider(user.orgId, "vm0");
        await setOrgCredits(user.orgId, 10_000);

        const counter = createQueryCounter();
        try {
          const response = await POST(
            createTestRequest(URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                prompt: "dedup with vm0 credit admission",
              }),
            }),
          );

          expect(response.status).toBe(201);
          expect(counter.countMatching(/from\s+"?zero_agents"?/i)).toBe(1);
          expect(counter.countMatching(/from\s+"?org_metadata"?/i)).toBe(1);
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

    describe("credit check with modelSelection", () => {
      it("rejects vm0 provider via modelSelection when org credits depleted", async () => {
        await setOrgCredits(user.orgId, 0);
        await insertOrgNonDefaultModelProvider(user.orgId, "vm0");
        const vm0ProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "vm0",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "should be rejected due to credits",
              modelSelection: {
                modelProviderId: vm0ProviderId,
                selectedModel: "claude-opus-4-7",
              },
            }),
          }),
        );

        expect(response.status).toBe(402);
        const data = await response.json();
        expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
      });
    });

    describe("eager-pin / orphan provider", () => {
      it("eager-pins thread to agent's modelProvider on creation", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          providerId,
          "claude-opus-4-7",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              prompt: "kick off thread",
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(providerId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("keeps thread pinned to original provider after agent provider changes", async () => {
        const originalProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          originalProviderId,
          "claude-opus-4-7",
        );

        const create = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "first" }),
          }),
        );
        expect(create.status).toBe(201);
        const { threadId } = await create.json();

        // Agent owner switches the agent's default provider after the
        // thread is created — the thread must keep its original pin.
        await insertOrgDefaultModelProvider(user.orgId, "openai-api-key");
        const newProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "openai-api-key",
        );
        await setTestZeroAgentModelProvider(agentId, newProviderId, "gpt-5");

        const followUp = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "follow up", threadId }),
          }),
        );
        expect(followUp.status).toBe(201);

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(originalProviderId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("returns 422 PROVIDER_DELETED when the eager-pinned provider is gone", async () => {
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          providerId,
          "claude-opus-4-7",
        );

        const create = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "first" }),
          }),
        );
        expect(create.status).toBe(201);
        const { threadId } = await create.json();

        // Provider is deleted by the org admin between sends. The thread
        // must surface PROVIDER_DELETED rather than silently fall back.
        await deleteTestModelProvider(providerId);

        const followUp = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "should fail", threadId }),
          }),
        );
        expect(followUp.status).toBe(422);
        const data = await followUp.json();
        expect(data.error.code).toBe("PROVIDER_DELETED");

        // The thread row keeps the now-stale UUID so the resolver can
        // detect the orphan-pin state on later sends.
        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(providerId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("leaves thread NULL when agent has no provider configured", async () => {
        // Default test agent has no modelProviderId / selectedModel.
        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "default-claude-code" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBeNull();
        expect(override.selectedModel).toBeNull();
      });

      it("falls back to agent provider when legacy thread has NULL pin", async () => {
        // Create the thread with no pin (mirrors a row from before
        // the eager-pin migration).
        const create = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "legacy" }),
          }),
        );
        expect(create.status).toBe(201);
        const { threadId } = await create.json();

        const before = await getTestChatThreadModelOverride(threadId);
        expect(before.modelProviderId).toBeNull();
        expect(before.selectedModel).toBeNull();

        // Now pin the agent and resend without a per-run modelSelection.
        // The send must succeed using the agent's current provider; the
        // thread itself stays NULL until the user explicitly picks.
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          providerId,
          "claude-opus-4-7",
        );

        const followUp = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "follow up", threadId }),
          }),
        );
        expect(followUp.status).toBe(201);

        const after = await getTestChatThreadModelOverride(threadId);
        expect(after.modelProviderId).toBeNull();
        expect(after.selectedModel).toBeNull();
      });
    });

    describe("personal-tier eager-pin (#11918)", () => {
      it("falls through to agent's pin when feature switch is OFF", async () => {
        // Agent has the flag on but the staff-only switch is not flipped
        // for this user — pin must remain agent's id, not personal's.
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          orgProviderId,
          "claude-opus-4-7",
        );
        await setTestZeroAgentPreferPersonalProvider(agentId, true);
        await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          "gpt-5.4",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "switch off" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(orgProviderId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("falls through to agent's pin when flag is OFF", async () => {
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          orgProviderId,
          "claude-opus-4-7",
        );
        // Switch enabled but flag default false — eligibility false.
        await enablePersonalModelProviderForUser(user.orgId, user.userId);
        await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          "gpt-5.4",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "flag off" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(orgProviderId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("pins to user's personal default id when both flag and switch are ON", async () => {
        // Both gates open + user has a personal default with its own
        // selectedModel — pin must be the personal row's id and selectedModel.
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          orgProviderId,
          "claude-opus-4-7",
        );
        await setTestZeroAgentPreferPersonalProvider(agentId, true);
        await enablePersonalModelProviderForUser(user.orgId, user.userId);
        const personalProviderId = await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          "gpt-5.4",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "personal pin" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(personalProviderId);
        expect(override.selectedModel).toBe("gpt-5.4");
      });

      it("runs the personal default when the request explicitly inherits modelSelection null", async () => {
        // The web picker sends `modelSelection: null` when the user chooses
        // "Use agent default". That must inherit the newly created thread's
        // eager pin, not fall back to the agent's org-tier provider.
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("personal-null-inherit"),
          { noEnvironmentBlock: true },
        );
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          composeAgentId,
          orgProviderId,
          "claude-opus-4-7",
        );
        await setTestZeroAgentPreferPersonalProvider(composeAgentId, true);
        await enablePersonalModelProviderForUser(user.orgId, user.userId);
        const personalProviderId = await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          "gpt-5.4",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "explicit inherit personal pin",
              modelSelection: null,
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { runId, threadId } = await response.json();
        await context.mocks.flushAfter();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(personalProviderId);
        expect(override.selectedModel).toBe("gpt-5.4");

        const job = await findTestRunnerJobEntry(runId);
        expect(job).toBeDefined();
        expect(job!.executionContext.cliAgentType).toBe("codex");
      });

      it("uses the personal provider default when the agent model is incompatible", async () => {
        // Personal default has no selectedModel. The agent is pinned to a
        // DeepSeek VM0 model, which must not be paired with the user's
        // OpenAI provider. Fall back to the provider's default model instead.
        await insertOrgNonDefaultModelProvider(
          user.orgId,
          "vm0",
          "deepseek-v4-pro",
        );
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "vm0",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          orgProviderId,
          "deepseek-v4-pro",
        );
        await setTestZeroAgentPreferPersonalProvider(agentId, true);
        await enablePersonalModelProviderForUser(user.orgId, user.userId);
        const personalProviderId = await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          // selectedModel intentionally omitted
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "fallback selected" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(personalProviderId);
        expect(override.selectedModel).toBe("gpt-5.5");
      });

      it("falls through to agent's pin when user has no personal providers", async () => {
        // Eligible but the user has not seeded any personal rows yet —
        // graceful degradation to the agent's pin.
        const orgProviderId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await setTestZeroAgentModelProvider(
          agentId,
          orgProviderId,
          "claude-opus-4-7",
        );
        await setTestZeroAgentPreferPersonalProvider(agentId, true);
        await enablePersonalModelProviderForUser(user.orgId, user.userId);

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "no personal" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(orgProviderId);
        expect(override.selectedModel).toBe("claude-opus-4-7");
      });

      it("pins to user's personal id even when agent has no provider configured", async () => {
        // Agent has no modelProviderId/selectedModel, but user has a
        // personal default and is eligible — pin uses the personal row.
        await setTestZeroAgentPreferPersonalProvider(agentId, true);
        await enablePersonalModelProviderForUser(user.orgId, user.userId);
        const personalProviderId = await insertUserDefaultModelProvider(
          user.orgId,
          user.userId,
          "openai-api-key",
          "gpt-5.4",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, prompt: "no agent pin" }),
          }),
        );
        expect(response.status).toBe(201);
        const { threadId } = await response.json();

        const override = await getTestChatThreadModelOverride(threadId);
        expect(override.modelProviderId).toBe(personalProviderId);
        expect(override.selectedModel).toBe("gpt-5.4");
      });
    });

    describe("dispatch framework derivation (Issue #11645)", () => {
      // Production-shape regression: thread eager-pinned to an
      // openai-api-key provider on a compose that says framework:
      // claude-code (the default) and has no explicit env block — the
      // production case where the org provider injects the auth secret
      // at runtime. Pre-fix, the dispatched runner_job_queue entry
      // carried cliAgentType="claude-code" and launched the wrong
      // binary. The fix wires resolvedFramework through
      // ExecutionContext so the provider's framework wins.
      it("dispatches cliAgentType=codex when pinned to openai-api-key provider on a claude-code compose", async () => {
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("codex-pin"),
          { noEnvironmentBlock: true },
        );
        await insertOrgDefaultModelProvider(user.orgId, "openai-api-key");
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "openai-api-key",
        );
        await setTestZeroAgentModelProvider(
          composeAgentId,
          providerId,
          "gpt-5",
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "kick off codex",
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { runId } = await response.json();
        await context.mocks.flushAfter();

        const job = await findTestRunnerJobEntry(runId);
        expect(job).toBeDefined();
        expect(job!.executionContext.cliAgentType).toBe("codex");
      });

      it("dispatches cliAgentType=claude-code when no provider override forces a different framework", async () => {
        // Default agent (no eager-pin) on a compose with no explicit
        // env block — org default anthropic-api-key (from beforeEach)
        // resolves to claude-code, matching the compose's framework.
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("default-cc"),
          { noEnvironmentBlock: true },
        );

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "default claude-code",
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { runId } = await response.json();
        await context.mocks.flushAfter();

        const job = await findTestRunnerJobEntry(runId);
        expect(job).toBeDefined();
        expect(job!.executionContext.cliAgentType).toBe("claude-code");
      });
    });

    describe("session continue framework derivation (Issue #11728)", () => {
      // Production regression: chat thread eager-pinned to an
      // openai-api-key provider on a compose declaring framework:
      // claude-code. The first message dispatches cliAgentType=codex
      // (from #11649), which the runner persists onto
      // conversation.cliAgentType. Pre-fix, the second message failed
      // because resolveSession compared the compose's literal framework
      // ("claude-code") against the conversation's recorded framework
      // ("codex"). Post-fix, the framework-compatibility check moved
      // to build-zero-context and uses resolvedFramework.
      it("dispatches cliAgentType=codex on the second message of an openai-pinned thread", async () => {
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("continue-codex"),
          { noEnvironmentBlock: true },
        );
        await insertOrgDefaultModelProvider(user.orgId, "openai-api-key");
        const providerId = await getTestModelProviderIdByType(
          user.orgId,
          "openai-api-key",
        );
        await setTestZeroAgentModelProvider(
          composeAgentId,
          providerId,
          "gpt-5",
        );

        const first = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "first",
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId, runId } = await first.json();
        await context.mocks.flushAfter();

        // Fake the runner completion: creates conversation +
        // agent_session. Stamp cliAgentType=codex on the conversation
        // to mirror the post-#11649 webhook behavior (which writes the
        // actually-dispatched framework, not the compose's literal one).
        const { agentSessionId } = await completeTestRun(user.userId, runId);
        await setTestSessionFramework(agentSessionId, "codex");

        const second = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "second",
              threadId,
            }),
          }),
        );
        expect(second.status).toBe(201);
        const { runId: secondRunId } = await second.json();
        await context.mocks.flushAfter();

        const job = await findTestRunnerJobEntry(secondRunId);
        expect(job).toBeDefined();
        expect(job!.executionContext.cliAgentType).toBe("codex");
      });

      it("fails the second-message run when resolvedFramework no longer matches the conversation's framework", async () => {
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("continue-codex-mismatch"),
          { noEnvironmentBlock: true },
        );

        // Force the cross-framework fallback path (no eager-pin on the
        // agent or thread, so the route relies on the org default). On
        // the first message the only default is openai-api-key (codex);
        // on the second message we flip it back to anthropic-api-key
        // (claude-code) to surface the framework mismatch against the
        // conversation's persisted cliAgentType=codex.
        const anthropicId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await deleteTestModelProvider(anthropicId);
        await insertOrgDefaultModelProvider(user.orgId, "openai-api-key");

        const first = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "first",
            }),
          }),
        );
        expect(first.status).toBe(201);
        const { threadId, runId } = await first.json();
        await context.mocks.flushAfter();

        const { agentSessionId } = await completeTestRun(user.userId, runId);
        await setTestSessionFramework(agentSessionId, "codex");

        // Flip the org default back to anthropic-api-key so the
        // resolved framework for the second message is claude-code.
        const codexId = await getTestModelProviderIdByType(
          user.orgId,
          "openai-api-key",
        );
        await deleteTestModelProvider(codexId);
        await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

        const second = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "second",
              threadId,
            }),
          }),
        );
        // Phase 1 admits the run; the framework-compat check runs in
        // Phase 2 (deferred dispatch) and surfaces as a failed run.
        expect(second.status).toBe(201);
        const { runId: secondRunId } = await second.json();
        await context.mocks.flushAfter();

        const failedRun = await getTestRun(secondRunId);
        expect(failedRun.status).toBe("failed");
        expect(failedRun.error).toMatch(
          /framework changed from "codex" to "claude-code"/,
        );
      });
    });

    describe("admission cross-framework default (Issue #11684)", () => {
      // Admission-layer regression for Epic #11520's residual gap:
      // a claude-code compose with no env block, served by an org whose
      // only isDefault provider is openai-api-key (codex framework). The
      // request body carries no modelProviderId or modelSelection — the
      // path the Web UI takes when the org has no claude-code default.
      // Pre-fix, admission threw noModelProvider() and the UI rendered
      // "Oops, something went wrong". Post-fix, admission falls back to
      // the org's cross-framework default and the provider's framework
      // propagates downstream via resolvedFramework.
      it("admits a claude-code compose when the org's only default is openai-api-key (codex)", async () => {
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("admit-cross-framework"),
          { noEnvironmentBlock: true },
        );

        // Wipe the beforeEach-seeded anthropic provider so the org has
        // only an openai-api-key (codex) provider as its default.
        const anthropicId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await deleteTestModelProvider(anthropicId);
        await insertOrgDefaultModelProvider(user.orgId, "openai-api-key");

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "claude-code compose, codex provider",
            }),
          }),
        );
        expect(response.status).toBe(201);
        const { runId } = await response.json();
        await context.mocks.flushAfter();

        const job = await findTestRunnerJobEntry(runId);
        expect(job).toBeDefined();
        expect(job!.executionContext.cliAgentType).toBe("codex");
      });

      it("returns 422 NO_MODEL_PROVIDER when org has no default provider at all", async () => {
        const { agentId: composeAgentId } = await createTestCompose(
          uniqueId("no-default-provider"),
          { noEnvironmentBlock: true },
        );

        // Wipe the beforeEach-seeded anthropic provider so the org has
        // no isDefault: true provider for any framework — the genuine
        // "no provider configured at all" failure mode.
        const anthropicId = await getTestModelProviderIdByType(
          user.orgId,
          "anthropic-api-key",
        );
        await deleteTestModelProvider(anthropicId);

        const response = await POST(
          createTestRequest(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId: composeAgentId,
              prompt: "should fail",
            }),
          }),
        );
        expect(response.status).toBe(422);
        const data = await response.json();
        expect(data.error.code).toBe("NO_MODEL_PROVIDER");
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
