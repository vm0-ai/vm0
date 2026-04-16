import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("userMessage line break rendering", () => {
  it("should preserve newlines between words in user messages", async () => {
    server.use(
      http.get(
        "*/api/zero/chat-threads/thread-multiline/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          return HttpResponse.json({
            messages: [
              {
                id: "msg-1",
                role: "user",
                content: "Hello\nWorld",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            hasMore: false,
          });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-multiline",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
      http.get(
        "*/api/zero/chat-threads/thread-singleline/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          return HttpResponse.json({
            messages: [
              {
                id: "msg-1",
                role: "user",
                content: "Hello World",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            hasMore: false,
          });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-singleline",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
      http.get(
        "*/api/zero/chat-threads/thread-provider-error/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          return HttpResponse.json({
            messages: [
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
                  "Cannot continue session: this session was created with Moonshot (Kimi) and cannot be continued with Anthropic API Key.",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            hasMore: false,
          });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-provider-error",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
    );

    detachedSetupPage({ context, path: "/chats/thread-provider-error" });

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
      expect(screen.getByText(/Start a new session/)).toBeInTheDocument();
    });
  });

  it("should show friendly message for thinking block signature error", async () => {
    server.use(
      http.get(
        "*/api/zero/chat-threads/thread-signature-error/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          return HttpResponse.json({
            messages: [
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
            ],
            hasMore: false,
          });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-signature-error",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
      http.get(
        "*/api/zero/chat-threads/thread-avatar-test/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          return HttpResponse.json({ messages: [], hasMore: false });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-avatar-test",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
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
