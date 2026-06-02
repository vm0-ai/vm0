import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
  chatThreadRecommendedFollowupsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_RUN_ID = "d0000000-0000-4000-a000-000000000001";

function makeThreadMocks(threadId: string, messages: PagedChatMessage[]) {
  // Default runId for seeded user messages so they aren't treated as queued.
  // Tests that want a queued seed should pass `runId: undefined` explicitly.
  const seeded = messages.map((message) => {
    if (message.role !== "user" || "runId" in message) {
      return message;
    }
    return { ...message, runId: MOCK_RUN_ID };
  });
  server.use(
    mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      return respond(200, { messages: seeded });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("userMessage line break rendering", () => {
  it("should preserve newlines between words in user messages", async () => {
    makeThreadMocks("thread-multiline", [
      {
        id: "msg-1",
        role: "user",
        content: "Hello\nWorld",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-multiline",
    });

    // Find the <p> element that the Markdown renderer creates for the user
    // message (selector: "p" scopes to paragraph elements only).
    // Then assert that a <br> exists within that paragraph — <br> is the
    // correct HTML representation of a hard line break (CommonMark "  \n").
    await waitFor(() => {
      const paragraph = screen.getByText(/Hello/, { selector: "p" });
      expect(paragraph.querySelector("br")).toBeInTheDocument();
    });
  });

  it("should not alter single-line user messages", async () => {
    makeThreadMocks("thread-singleline", [
      {
        id: "msg-1",
        role: "user",
        content: "Hello World",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-singleline",
    });

    // Single-line messages with no \n should render as-is.
    await waitFor(() => {
      expect(screen.getByText("Hello World")).toBeInTheDocument();
    });
  });
});

describe("recommended follow-ups", () => {
  it("should render follow-ups and fill the composer when selected", async () => {
    makeThreadMocks("thread-followups", [
      {
        id: "msg-1",
        role: "user",
        content: "Help me plan a launch",
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Here is a launch outline with milestones and owners.",
        runId: MOCK_RUN_ID,
        status: "completed",
        runLifecycleEvent: "completed",
        createdAt: "2026-03-10T00:00:01Z",
      },
    ]);
    server.use(
      mockApi(chatThreadRecommendedFollowupsContract.list, ({ respond }) => {
        return respond(200, {
          suggestions: [
            "Turn this into a week-by-week checklist",
            "Identify the highest-risk launch tasks",
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-followups",
    });

    await screen.findByText("Recommended follow-ups");
    const followupButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes(
        "Turn this into a week-by-week checklist",
      );
    });
    if (!followupButton) {
      throw new Error("Expected recommended follow-up button");
    }
    await userEvent.click(followupButton);

    expect(screen.getByRole("textbox")).toHaveValue(
      "Turn this into a week-by-week checklist",
    );
  });
});

describe("provider incompatibility error", () => {
  it("should show friendly message for API-level provider incompatibility", async () => {
    makeThreadMocks("thread-provider-error", [
      {
        id: "msg-1",
        role: "user",
        content: "hello",
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: null,
        runId: "run-incompatible",
        status: "failed",
        error:
          "Cannot continue session: this session was created with Moonshot (Kimi) and cannot be continued with Anthropic.",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-provider-error" });

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
      expect(screen.getByText(/Start a new session/)).toBeInTheDocument();
    });
  });

  it("should show friendly message for thinking block signature error", async () => {
    makeThreadMocks("thread-signature-error", [
      {
        id: "msg-1",
        role: "user",
        content: "hello",
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: null,
        runId: "run-signature",
        status: "failed",
        error: "Invalid signature in thinking block",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-signature-error" });

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
      expect(screen.getByText(/Start a new session/)).toBeInTheDocument();
    });
  });
});
