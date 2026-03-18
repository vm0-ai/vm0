import { describe, expect, it } from "vitest";
import { screen, waitFor, getDefaultNormalizer } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

// Normalizer that preserves whitespace (including newlines) so assertions can
// distinguish between "Hello World" (soft wrap) and "Hello\nWorld" (hard break).
const noCollapseNormalizer = getDefaultNormalizer({
  collapseWhitespace: false,
});

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

    // Without the fix, CommonMark collapses \n into a space so the message
    // renders as "Hello World". With the fix, a hard line break separates the
    // two words. Using a non-collapsing normalizer, "Hello World" should not be
    // found as a single text run anywhere in the rendered tree.
    await waitFor(() => {
      expect(
        screen.queryByText("Hello World", { normalizer: noCollapseNormalizer }),
      ).toBeNull();
      expect(
        screen.getByText(/Hello/, { normalizer: noCollapseNormalizer }),
      ).toBeInTheDocument();
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

    // Single-line messages with no \n should render with the words on one line.
    await waitFor(() => {
      expect(
        screen.getByText("Hello World", { normalizer: noCollapseNormalizer }),
      ).toBeInTheDocument();
    });
  });
});
