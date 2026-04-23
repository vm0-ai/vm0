import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";
import { logsByIdContract } from "@vm0/core/contracts/logs";
import {
  zeroRunAgentEventsContract,
  zeroRunsByIdContract,
} from "@vm0/core/contracts/zero-runs";
import { zeroQueuePositionContract } from "@vm0/core/contracts/zero-queue-position";

const context = testContext();
const mockApi = createMockApi(context);

describe("chat session switch", () => {
  it("should show running state when switching to a session with an active run", async () => {
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ params, query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        const id = params.threadId;
        if (id === "thread-completed") {
          return respond(200, {
            messages: [
              {
                id: "msg-1",
                role: "user",
                content: "Done task",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "msg-2",
                role: "assistant",
                content: "All done!",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        }
        // thread-running
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Active task prompt",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-2",
              role: "assistant",
              content: null,
              runId: "run-active",
              status: "running",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        const id = params.id;
        if (id === "thread-completed") {
          return respond(200, {
            id: "thread-completed",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [],
            latestSessionId: null,
            activeRunIds: [],
            draftContent: null,
            draftAttachments: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }
        // thread-running
        return respond(200, {
          id: "thread-running",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: ["run-active"],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(logsByIdContract.getById, ({ respond }) => {
        return respond(200, {
          id: "a0000000-0000-4000-a000-000000000099",
          sessionId: "session-1",
          agentId: "zero",
          displayName: null,
          framework: "claude-code",
          modelProvider: null,
          selectedModel: null,
          triggerSource: "web",
          triggerAgentName: null,
          scheduleId: null,
          status: "running",
          prompt: "Active task prompt",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-03-10T00:00:00Z",
          startedAt: "2026-03-10T00:00:01Z",
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      }),
      mockApi(zeroRunsByIdContract.getById, ({ respond }) => {
        return respond(200, {
          runId: "run-active",
          agentComposeVersionId: null,
          status: "running",
          prompt: "Active task prompt",
          appendSystemPrompt: null,
          result: { agentSessionId: "session-1", output: "" },
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(zeroQueuePositionContract.getPosition, ({ respond }) => {
        return respond(200, { position: 0, total: 0 });
      }),
    );

    // Start on a completed thread (no active polling)
    detachedSetupPage({ context, path: "/chats/thread-completed" });

    await waitFor(() => {
      expect(screen.getByText("All done!")).toBeInTheDocument();
    });

    // No Stop button should be present
    expect(screen.queryByLabelText("Stop")).toBeNull();

    // Navigate to the running thread
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-running" },
    });

    // Stop button should appear for the active run
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("should load different messages when switching between completed sessions", async () => {
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ params, query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        const id = params.threadId;
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: `Question for ${id}`,
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-2",
              role: "assistant",
              content: `Answer for ${id}`,
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/session-alpha" });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-alpha")).toBeInTheDocument();
    });

    // Switch to session-beta
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "session-beta" },
    });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-beta")).toBeInTheDocument();
    });

    // Previous session content should be gone
    expect(screen.queryByText("Answer for session-alpha")).toBeNull();

    // Switch to session-gamma
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "session-gamma" },
    });

    await waitFor(() => {
      expect(screen.getByText("Answer for session-gamma")).toBeInTheDocument();
    });

    // Only current session content visible
    expect(screen.queryByText("Answer for session-beta")).toBeNull();
  });
});
