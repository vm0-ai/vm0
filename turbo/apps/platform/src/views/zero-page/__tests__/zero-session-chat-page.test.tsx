import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

/**
 * Returns the first <p> element in the document whose textContent
 * includes the given substring (case-sensitive, un-normalized).
 */
function findParagraphWithText(text: string): HTMLElement | null {
  for (const el of document.querySelectorAll("p")) {
    if ((el.textContent ?? "").includes(text)) {
      return el as HTMLElement;
    }
  }
  return null;
}

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
    // renders as "Hello World". With the fix, a hard line break separates
    // them, so the paragraph's raw textContent does not contain "Hello World"
    // (no space between the two words).
    await waitFor(() => {
      const paragraph = findParagraphWithText("Hello");
      expect(paragraph).not.toBeNull();
      expect(paragraph?.textContent).toContain("World");
      expect(paragraph?.textContent).not.toContain("Hello World");
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

    // Single-line messages with no \n should render with the words on one line,
    // meaning the paragraph's raw textContent contains "Hello World".
    await waitFor(() => {
      const paragraph = findParagraphWithText("Hello World");
      expect(paragraph).not.toBeNull();
    });
  });
});
