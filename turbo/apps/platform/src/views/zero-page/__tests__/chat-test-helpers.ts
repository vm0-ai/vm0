import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import type { SummaryEntry } from "@vm0/core";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

export async function sendMessageInUI(
  user: ReturnType<typeof userEvent.setup>,
  textarea: HTMLTextAreaElement,
  text: string,
): Promise<void> {
  await user.clear(textarea);
  await user.type(textarea, text);
  await user.keyboard("{Enter}");
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
  agentId: string;
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
  onRunCreate?: () => void;
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
                runId: "a0000000-0000-4000-a000-000000000001",
                status: runStatus,
                prompt: runPrompt ?? "Hello",
                error: runError,
              },
            ]
          : []);
      return HttpResponse.json({
        id: threadId,
        title: options?.threadTitle ?? null,
        agentId: "c0000000-0000-4000-a000-000000000001",
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
      HttpResponse.json(
        { id: threadId, title: null, createdAt: "2026-03-10T00:00:00Z" },
        { status: 201 },
      ),
    ),
    // Unified chat message endpoint (creates thread + run + association)
    http.post("*/api/zero/chat/messages", async ({ request }) => {
      const body = (await request.json()) as { prompt?: string };
      if (body.prompt) {
        runPrompt = body.prompt;
      }
      options?.onRunCreate?.();
      runAssociated = true;
      return HttpResponse.json(
        {
          runId: "run-test-1",
          threadId,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
    }),
    http.get("*/api/zero/logs/:id", () =>
      HttpResponse.json({
        id: "a0000000-0000-4000-a000-000000000001",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        selectedModel: null,
        triggerSource: "web",
        triggerAgentName: null,
        scheduleId: null,
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
    http.post("*/api/zero/runs/:id/cancel", () =>
      HttpResponse.json({
        id: "a0000000-0000-4000-a000-000000000001",
        status: "cancelled",
        message: "Run cancelled",
      }),
    ),
    http.get("*/api/zero/runs/:id", () =>
      HttpResponse.json({
        runId: "a0000000-0000-4000-a000-000000000001",
        agentComposeVersionId: null,
        status: runStatus,
        prompt: runPrompt ?? "Hello",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1", output: resultContent },
        createdAt: "2026-03-10T00:00:00Z",
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
