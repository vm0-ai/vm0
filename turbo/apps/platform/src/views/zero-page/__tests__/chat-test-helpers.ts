import { fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import { act } from "react";
import type { SummaryEntry } from "@vm0/core";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

export function sendMessageInUI(
  textarea: HTMLTextAreaElement,
  text: string,
): void {
  fireEvent.change(textarea, { target: { value: text } });
  act(() => {
    textarea.dispatchEvent(
      Object.assign(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        {
          preventDefault: () => {},
        },
      ),
    );
  });
}

export function makeToolUseEvent(
  name: string,
  input?: Record<string, unknown>,
  seq = 1,
): AgentEvent {
  return {
    sequenceNumber: seq,
    eventType: "tool_use",
    eventData: {
      message: { content: [{ type: "tool_use", name, input: input ?? {} }] },
    },
    createdAt: `2026-03-10T00:00:${String(seq).padStart(2, "0")}Z`,
  };
}

interface ThreadListItem {
  id: string;
  title: string | null;
  preview: string | null;
  agentComposeId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockLifecycleControl {
  setRunStatus: (status: string) => void;
  setQueuePosition: (n: number) => void;
  setEvents: (e: AgentEvent[]) => void;
  setThreadList: (list: ThreadListItem[]) => void;
  completeRun: (content?: string) => void;
  failRun: (error: string) => void;
  cancelRun: () => void;
}

export function mockChatLifecycle(options?: {
  threadId?: string;
  chatMessages?: {
    role: "user" | "assistant";
    content: string;
    runId?: string;
    error?: string;
    summaries?: SummaryEntry[];
    createdAt: string;
  }[];
  unsavedRuns?: {
    runId: string;
    status: string;
    prompt: string;
    error: string | null;
  }[];
  threadTitle?: string | null;
}): MockLifecycleControl {
  const threadId = options?.threadId ?? "thread-test-1";
  const chatMessages = options?.chatMessages ?? [];
  const unsavedRuns = options?.unsavedRuns;

  let runStatus = "running";
  let runError: string | null = null;
  let events: AgentEvent[] = [];
  let queuePosition = 0;
  let resultContent = "";
  let threadList: ThreadListItem[] = [];
  let runPrompt: string | null = null;
  let runAssociated = false;

  server.use(
    http.get("*/api/zero/chat-threads/:id", () => {
      // After a run is associated, include it in unsavedRuns so the snapshot
      // can reconstruct messages (mirrors real server behaviour).
      const effectiveUnsavedRuns =
        unsavedRuns ??
        (runAssociated
          ? [
              {
                runId: "run-test-1",
                status: runStatus,
                prompt: runPrompt ?? "Hello",
                error: runError,
              },
            ]
          : []);
      return HttpResponse.json({
        id: threadId,
        title: options?.threadTitle ?? null,
        agentComposeId: "mock-compose-id",
        chatMessages,
        latestSessionId: null,
        unsavedRuns: effectiveUnsavedRuns,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: threadList }),
    ),
    http.post("*/api/zero/chat-threads", () =>
      HttpResponse.json({ id: threadId, title: null }, { status: 201 }),
    ),
    http.post("*/api/zero/chat-threads/:id/runs", () => {
      runAssociated = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("*/api/zero/runs", async ({ request }) => {
      const body = (await request.json()) as { prompt?: string };
      if (body.prompt) {
        runPrompt = body.prompt;
      }
      return HttpResponse.json({ runId: "run-test-1" }, { status: 201 });
    }),
    http.get("*/api/zero/logs/:id", () =>
      HttpResponse.json({
        id: "run-test-1",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        triggerSource: "web",
        status: runStatus,
        prompt: "Hello",
        appendSystemPrompt: null,
        error: runError,
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: null,
        artifact: { name: null, version: null },
      }),
    ),
    http.get("*/api/zero/runs/:id/telemetry/agent", () =>
      HttpResponse.json({ events, hasMore: false, framework: "claude-code" }),
    ),
    http.post(
      "*/api/zero/runs/:id/cancel",
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get("*/api/zero/runs/:id", () =>
      HttpResponse.json({
        result: { agentSessionId: "session-1", output: resultContent },
      }),
    ),
    http.get("*/api/zero/queue-position", () =>
      HttpResponse.json({ position: queuePosition }),
    ),
  );

  return {
    setRunStatus: (s) => {
      runStatus = s;
    },
    setQueuePosition: (n) => {
      queuePosition = n;
    },
    setEvents: (e) => {
      events = e;
    },
    setThreadList: (list) => {
      threadList = list;
    },
    completeRun: (content?: string) => {
      runStatus = "completed";
      resultContent = content ?? "";
      if (content) {
        events = [
          ...events,
          {
            sequenceNumber: events.length + 1,
            eventType: "result",
            eventData: { result: content },
            createdAt: "2026-03-10T00:01:00Z",
          },
        ];
      }
    },
    failRun: (error: string) => {
      runStatus = "failed";
      runError = error;
    },
    cancelRun: () => {
      runStatus = "cancelled";
    },
  };
}
