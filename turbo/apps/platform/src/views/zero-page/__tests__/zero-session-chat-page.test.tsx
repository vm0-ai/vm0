import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

describe("userMessage line break rendering", () => {
  it("should preserve newlines between words in user messages", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-multiline",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "Hello\nWorld",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

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
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-singleline",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "Hello World",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

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

describe("provider incompatibility error", () => {
  it("should show friendly message for API-level provider incompatibility", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-provider-error",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "hello",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: null,
              runId: "run-incompatible",
              status: "failed",
              error:
                "Cannot continue session: this session was created with Moonshot (Kimi) and cannot be continued with Anthropic API Key.",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-provider-error" });

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
      expect(screen.getByText(/Start a new session/)).toBeInTheDocument();
    });
  });

  it("should show friendly message for thinking block signature error", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-signature-error",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "hello",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: null,
              runId: "run-signature",
              status: "failed",
              error: "Invalid signature in thinking block",
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-signature-error" });

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
      expect(screen.getByText(/Start a new session/)).toBeInTheDocument();
    });
  });
});

describe("agent avatar link", () => {
  it("should link to team detail page", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-avatar-test",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-avatar-test" });

    const link = await waitFor(() => {
      return screen.getByLabelText("View agent profile");
    });
    expect(link).toHaveAttribute(
      "href",
      "/agents/c0000000-0000-4000-a000-000000000001",
    );
  });
});

describe("chat message activity line", () => {
  it("should keep activity line visible when result arrives but run is still running", async () => {
    const lifecycle = mockChatLifecycle({
      threadId: "thread-activity-running",
      chatMessages: [
        {
          role: "user",
          content: "Do something",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-activity-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    // Provide a result event while keeping the run status as "running"
    lifecycle.setEvents([
      {
        sequenceNumber: 1,
        eventType: "result",
        eventData: { result: "Here is the partial result" },
        createdAt: "2026-03-10T00:00:10Z",
      },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-activity-running" });

    // The activity line (spinner) should be visible since the run is not terminal.
    // The response body is hidden during active runs to prevent layout shift.
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // The result body should not be rendered while the run is still active
    await waitFor(() => {
      expect(
        screen.queryByText("Here is the partial result"),
      ).not.toBeInTheDocument();
    });
  });

  it("should hide activity line after run reaches terminal status", async () => {
    const lifecycle = mockChatLifecycle({
      threadId: "thread-activity-done",
      chatMessages: [
        {
          role: "user",
          content: "Do something else",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-activity-2",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    // Start with a result event while still running
    lifecycle.setEvents([
      {
        sequenceNumber: 1,
        eventType: "result",
        eventData: { result: "Final answer" },
        createdAt: "2026-03-10T00:00:10Z",
      },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-activity-done" });

    // Activity line should be visible while running; body is hidden during active runs
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Now complete the run
    lifecycle.completeRun("Final answer");

    // Activity line should disappear and body should appear after reaching terminal status
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Final answer")).toBeInTheDocument();
    });
  });
});
