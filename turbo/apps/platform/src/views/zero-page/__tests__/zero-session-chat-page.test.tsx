import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("userMessage line break rendering", () => {
  it("should render hard line breaks for newlines in user messages", async () => {
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

    await waitFor(() => {
      expect(document.querySelector("br")).toBeInTheDocument();
    });
  });

  it("should not add extra line breaks to single-line user messages", async () => {
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

    await waitFor(() => {
      expect(document.body.textContent).toContain("Hello World");
    });

    expect(document.querySelector(".zero-chat-bubble-user br")).toBeNull();
  });
});
