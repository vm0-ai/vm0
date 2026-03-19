import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("userMessage line break rendering", () => {
  it("should preserve newlines between words in user messages", async () => {
    server.use(
      http.get("*/api/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-multiline",
          title: null,
          agentComposeId: "mock-compose-id",
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
      http.get("*/api/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({
      context,
      path: "/chat/thread-multiline",
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
      http.get("*/api/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-singleline",
          title: null,
          agentComposeId: "mock-compose-id",
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
      http.get("*/api/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({
      context,
      path: "/chat/thread-singleline",
    });

    // Single-line messages with no \n should render as-is.
    await waitFor(() => {
      expect(screen.getByText("Hello World")).toBeInTheDocument();
    });
  });
});
