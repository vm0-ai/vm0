import { describe, it, expect } from "vitest";
import { delay } from "signal-timers";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  zeroCurrentSessionId$,
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  zeroSessionError$,
  setZeroChatInput$,
  clearZeroChatInput$,
  fetchZeroSessionList$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
} from "../zero-chat.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

describe("zero-chat signals", () => {
  describe("chat input", () => {
    it("should set and clear chat input", async () => {
      await setup();

      context.store.set(setZeroChatInput$, "hello world");
      expect(context.store.get(zeroChatInput$)).toBe("hello world");

      context.store.set(clearZeroChatInput$);
      expect(context.store.get(zeroChatInput$)).toBe("");
    });
  });

  describe("fetchZeroSessionList$", () => {
    it("should fetch and store session list", async () => {
      server.use(
        http.get("*/api/agent/sessions", () => {
          return HttpResponse.json({
            sessions: [
              { id: "s1", preview: "Hello", createdAt: "2026-03-10T00:00:00Z" },
              { id: "s2", preview: "World", createdAt: "2026-03-10T01:00:00Z" },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      const sessions = context.store.get(zeroSessionList$);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.id).toBe("s1");
      expect(sessions[1]?.preview).toBe("World");
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
      expect(context.store.get(zeroSessionListError$)).toBeNull();
    });

    it("should set error on API failure", async () => {
      server.use(
        http.get("*/api/agent/sessions", () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      expect(context.store.get(zeroSessionListError$)).toBe(
        "Failed to load sessions: Internal Server Error",
      );
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
    });

    it("should pass agentComposeId as query parameter", async () => {
      let capturedUrl = "";
      server.use(
        http.get("*/api/agent/sessions", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ sessions: [] });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("agentComposeId")).toBe("mock-compose-id");
    });
  });

  describe("switchZeroSession$", () => {
    it("should set session id immediately and load messages", async () => {
      server.use(
        http.get("*/api/agent/sessions/:id", () => {
          return HttpResponse.json({
            chatMessages: [
              {
                role: "user",
                content: "Hi there",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                role: "assistant",
                content: "Hello!",
                runId: "run-1",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(switchZeroSession$, "session-abc");

      expect(context.store.get(zeroCurrentSessionId$)).toBe("session-abc");

      const messages = context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("Hi there");
      expect(messages[1]?.role).toBe("assistant");
      expect(messages[1]?.content).toBe("Hello!");
      expect(context.store.get(zeroSessionError$)).toBeNull();
    });

    it("should set error on API failure", async () => {
      server.use(
        http.get("*/api/agent/sessions/:id", () => {
          return new HttpResponse(null, {
            status: 404,
            statusText: "Not Found",
          });
        }),
      );

      await setup();
      await context.store.set(switchZeroSession$, "bad-session");

      expect(context.store.get(zeroSessionError$)).toBe(
        "Failed to load session: Not Found",
      );
    });

    it("should abort in-flight polling when switching sessions", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/agent/runs", () => {
          return HttpResponse.json({ runId: "run-old" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          pollCount++;
          // Return non-terminal status to keep polling alive
          return HttpResponse.json({
            id: "run-old",
            status: "running",
            error: null,
            prompt: "test",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
        http.get("*/api/agent/sessions/:id", () => {
          return HttpResponse.json({
            chatMessages: [
              {
                role: "user",
                content: "New session msg",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();

      // Start a send (it will enter the polling loop since status is "running")
      const sendPromise = context.store
        .set(sendZeroChatMessage$, "Start polling")
        .catch(() => {
          // AbortError is expected — the polling loop throws when aborted
        });

      // Wait briefly for the polling loop to begin phase 2
      await delay(50);

      // Verify polling actually started before we abort it
      expect(pollCount).toBeGreaterThan(0);

      // Switching sessions should abort the polling controller
      await context.store.set(switchZeroSession$, "new-session-id");

      // The send should complete (polling aborted via signal)
      await sendPromise;

      // Record poll count after abort and wait to verify no more polls happen
      const pollCountAfterAbort = pollCount;
      await delay(200);

      // No additional polls should have occurred after abort
      expect(pollCount).toBe(pollCountAfterAbort);

      // State should reflect the switched session
      expect(context.store.get(zeroCurrentSessionId$)).toBe("new-session-id");
      const messages = context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("New session msg");
    });

    it("should clear previous messages when switching", async () => {
      server.use(
        http.get("*/api/agent/sessions/:id", () => {
          return HttpResponse.json({ chatMessages: [] });
        }),
      );

      await setup();

      // Set some initial state
      context.store.set(setZeroChatInput$, "draft");
      await context.store.set(switchZeroSession$, "session-1");

      // Messages should be empty (from the empty response)
      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });
  });

  describe("startNewZeroSession$", () => {
    it("should reset all chat state", async () => {
      await setup();

      // Populate some state first
      context.store.set(setZeroChatInput$, "some input");

      context.store.set(startNewZeroSession$);

      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
      expect(context.store.get(zeroChatInput$)).toBe("");
    });

    it("should abort in-flight polling when starting a new session", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/agent/runs", () => {
          return HttpResponse.json({ runId: "run-poll" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          pollCount++;
          // Return non-terminal status to keep polling alive
          return HttpResponse.json({
            id: "run-poll",
            status: "running",
            error: null,
            prompt: "test",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
      );

      await setup();

      // Start a send (it will enter the polling loop since status is "running")
      const sendPromise = context.store
        .set(sendZeroChatMessage$, "Start polling")
        .catch(() => {
          // AbortError is expected — the polling loop throws when aborted
        });

      // Wait briefly for the polling loop to begin phase 2
      await delay(50);

      // Verify polling actually started before we abort it
      expect(pollCount).toBeGreaterThan(0);

      // Starting a new session should abort the polling controller
      context.store.set(startNewZeroSession$);

      // The send should complete (polling aborted via signal)
      await sendPromise;

      // Record poll count after abort and wait to verify no more polls happen
      const pollCountAfterAbort = pollCount;
      await delay(200);

      // No additional polls should have occurred after abort
      expect(pollCount).toBe(pollCountAfterAbort);

      // State should reflect the new session, not the old one
      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
    });
  });

  describe("sendZeroChatMessage$", () => {
    it("should add user and placeholder messages then start a run", async () => {
      let capturedBody: Record<string, string> | null = null;
      server.use(
        http.post("*/api/agent/runs", async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-123" });
        }),
        // Phase 1: telemetry events (eager load)
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        // Phase 2: polling checks /api/platform/logs/:runId for terminal status
        http.get("*/api/platform/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-123",
            status: "completed",
            error: null,
            prompt: "What can you do?",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        // onZeroRunComplete$ fetches /api/agent/runs/:runId for session id
        http.get("*/api/agent/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "new-session-id" },
          });
        }),
        // Persist messages endpoint
        http.post("*/api/agent/sessions/:id/messages", () => {
          return HttpResponse.json({ ok: true });
        }),
        // Session list refresh
        http.get("*/api/agent/sessions", () => {
          return HttpResponse.json({ sessions: [] });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "What can you do?");

      // Verify the run was started with correct payload
      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.agentComposeId).toBe("mock-compose-id");
      expect(capturedBody!.prompt).toBe("What can you do?");

      // After completion, sending should be false
      expect(context.store.get(zeroChatSending$)).toBeFalsy();

      // Messages should contain at least user + assistant
      const messages = context.store.get(zeroChatMessages$);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("What can you do?");
      expect(messages[1]?.role).toBe("assistant");
    });

    it("should set error on run creation failure", async () => {
      server.use(
        http.post("*/api/agent/runs", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "Hello");

      const messages = context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Failed to start agent run");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should not send empty messages", async () => {
      let runCalled = false;
      server.use(
        http.post("*/api/agent/runs", () => {
          runCalled = true;
          return HttpResponse.json({ runId: "run-123" });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "   ");

      expect(runCalled).toBeFalsy();
      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
    });

    it("should include sessionId when one exists", async () => {
      let capturedBody: Record<string, string> | null = null;
      server.use(
        http.get("*/api/agent/sessions/:id", () => {
          return HttpResponse.json({ chatMessages: [] });
        }),
        http.post("*/api/agent/runs", async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-456" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-456",
            status: "completed",
            error: null,
            prompt: "Follow up",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        http.get("*/api/agent/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "existing-session" },
          });
        }),
        http.post("*/api/agent/sessions/:id/messages", () => {
          return HttpResponse.json({ ok: true });
        }),
        http.get("*/api/agent/sessions", () => {
          return HttpResponse.json({ sessions: [] });
        }),
      );

      await setup();

      // First switch to a session to set the sessionId
      await context.store.set(switchZeroSession$, "existing-session");

      // Now send a message — it should include the sessionId
      await context.store.set(sendZeroChatMessage$, "Follow up");

      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.sessionId).toBe("existing-session");
    });
  });
});
