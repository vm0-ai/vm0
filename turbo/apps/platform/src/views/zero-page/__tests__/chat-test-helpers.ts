import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import {
  createChatMessage,
  createChatRun,
  updateChatRun,
} from "../../../mocks/mock-helpers.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";

import { fill } from "../../../__tests__/page-helper.ts";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";

export function mockSubagentThread(threadId: string) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: DEFAULT_AGENT_ID,
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: SUB_AGENT_ID,
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads/:id/messages", () => {
      return HttpResponse.json({ messages: [], hasMore: false });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: threadId,
        title: null,
        agentId: SUB_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/:id", ({ params }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string | null;
          ownerId: string;
          description: null;
          sound: null;
          avatarUrl: string | null;
          permissionPolicies: null;
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
        },
        [SUB_AGENT_ID]: {
          agentId: SUB_AGENT_ID,
          ownerId: "test-user",
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
          permissionPolicies: null,
        },
      };
      const agent = agents[params.id as string];
      if (!agent) {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }
      return HttpResponse.json(agent);
    }),
  );
}

export async function sendMessageInUI(
  user: ReturnType<typeof userEvent.setup>,
  textarea: HTMLTextAreaElement,
  text: string,
): Promise<void> {
  await fill(textarea, text);
  await user.keyboard("{Enter}");
}

interface ThreadListItem {
  id: string;
  title: string | null;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
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
    content: string | null;
    runId?: string;
    error?: string;
    status?: string;
    createdAt: string;
  }[];
  threadTitle?: string | null;
  onRunCreate?: () => void;
}): MockLifecycleControl {
  const threadId = options?.threadId ?? "thread-test-1";
  const chatMessages = options?.chatMessages ?? [];

  let runStatus = "running";
  let runError: string | null = null;
  let events: AgentEvent[] = [];
  let queuePosition = 0;
  let resultContent = "";
  let threadList: ThreadListItem[] = [];
  let runPrompt: string | null = null;
  let runAssociated = false;
  let threadTitle: string | null = options?.threadTitle ?? null;
  // Version counter: bumped whenever the run reaches a terminal state so
  // subsequent polls discover a "new" assistant message row (simulating the
  // real server inserting event-backed rows on run completion).
  let assistantVersion = 0;
  let lastDeliveredVersion = -1;

  server.use(
    // Paged messages endpoint — cursor-aware, version-aware mock.
    http.get("*/api/zero/chat-threads/:id/messages", ({ request }) => {
      const url = new URL(request.url);
      const sinceId = url.searchParams.get("sinceId");

      const assistantId = `msg-assistant-run-v${assistantVersion}`;

      const pagedMessages: {
        id: string;
        role: "user" | "assistant";
        content: string | null;
        runId?: string;
        error?: string;
        status?: string;
        createdAt: string;
      }[] = [];

      // Seed with pre-existing chatMessages (e.g. history on resume)
      for (let i = 0; i < chatMessages.length; i++) {
        pagedMessages.push({
          id: `msg-seed-${i}`,
          ...chatMessages[i]!,
        });
      }

      // After a run is associated, append user + assistant messages
      if (runAssociated) {
        pagedMessages.push({
          id: "msg-user-sent",
          role: "user",
          content: runPrompt ?? "Hello",
          createdAt: "2026-03-10T00:00:01Z",
        });
        pagedMessages.push({
          id: assistantId,
          role: "assistant",
          content: resultContent || null,
          runId: "run-test-1",
          error: runError ?? undefined,
          status: runStatus,
          createdAt: "2026-03-10T00:00:02Z",
        });
      }

      if (sinceId) {
        // If the assistant version bumped since the client's cursor, return
        // the updated assistant message as a "new" row. Otherwise return
        // empty to avoid duplicate keys.
        if (assistantVersion > lastDeliveredVersion && runAssociated) {
          lastDeliveredVersion = assistantVersion;
          const lastMsg = pagedMessages[pagedMessages.length - 1]!;
          return HttpResponse.json({
            messages: [lastMsg],
            hasMore: false,
          });
        }
        return HttpResponse.json({ messages: [], hasMore: false });
      }

      lastDeliveredVersion = assistantVersion;
      return HttpResponse.json({ messages: pagedMessages, hasMore: false });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      const terminal = new Set(["completed", "failed", "cancelled", "timeout"]);
      const seedActiveRunIds = chatMessages
        .filter((m): m is typeof m & { runId: string; status: string } => {
          return (
            m.runId !== undefined &&
            m.status !== undefined &&
            !terminal.has(m.status)
          );
        })
        .map((m) => {
          return m.runId;
        });
      const lifecycleActiveRunIds =
        runAssociated && !terminal.has(runStatus) ? ["run-test-1"] : [];
      const activeRunIds = [...seedActiveRunIds, ...lifecycleActiveRunIds];
      return HttpResponse.json({
        id: threadId,
        title: threadTitle,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: threadList });
    }),
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json(
        { id: threadId, title: null, createdAt: "2026-03-10T00:00:00Z" },
        { status: 201 },
      );
    }),
    http.post("*/api/zero/chat-threads/:id/mark-read", () => {
      return HttpResponse.json({ lastReadAt: new Date().toISOString() });
    }),
    // Unified chat message endpoint (creates thread + run + association)
    http.post("*/api/zero/chat/messages", async ({ request }) => {
      const body = (await request.json()) as { prompt?: string };
      if (body.prompt) {
        runPrompt = body.prompt;
      }
      options?.onRunCreate?.();
      runAssociated = true;
      createChatRun(threadId);
      createChatMessage(threadId);
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
    http.get("*/api/zero/logs/:id", () => {
      return HttpResponse.json({
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
      });
    }),
    http.get("*/api/zero/runs/:id/telemetry/agent", () => {
      return HttpResponse.json({
        events,
        hasMore: false,
        framework: "claude-code",
      });
    }),
    http.post("*/api/zero/runs/:id/cancel", () => {
      return HttpResponse.json({
        id: "a0000000-0000-4000-a000-000000000001",
        status: "cancelled",
        message: "Run cancelled",
      });
    }),
    http.get("*/api/zero/runs/:id", () => {
      return HttpResponse.json({
        runId: "a0000000-0000-4000-a000-000000000001",
        agentComposeVersionId: null,
        status: runStatus,
        prompt: runPrompt ?? "Hello",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1", output: resultContent },
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/queue-position", () => {
      return HttpResponse.json({ position: queuePosition });
    }),
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
      threadTitle = threadTitle ?? runPrompt;
      assistantVersion++;
      if (content) {
        events = [
          ...events,
          {
            sequenceNumber: events.length + 1,
            eventType: "assistant",
            eventData: {
              message: { content: [{ type: "text", text: content }] },
            },
            createdAt: "2026-03-10T00:01:00Z",
          },
        ];
      }
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
    failRun: (error: string) => {
      runStatus = "failed";
      runError = error;
      assistantVersion++;
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
    cancelRun: () => {
      runStatus = "cancelled";
      assistantVersion++;
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
  };
}
