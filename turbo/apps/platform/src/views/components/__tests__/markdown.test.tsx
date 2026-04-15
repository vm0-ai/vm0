import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setTheme$ } from "../../../signals/theme.ts";

const context = testContext();

const THREAD_BASE = {
  title: null,
  agentId: "c0000000-0000-4000-a000-000000000001",
  latestSessionId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as const;

describe("chat-d-064: markdown content renders from props", () => {
  it("should parse markdown and render as formatted HTML", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-markdown",
          ...THREAD_BASE,
          chatMessages: [
            {
              role: "assistant",
              content: "**bold text**",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      expect(
        screen.getByText("bold text", { selector: "strong, b" }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-065: theme signal applied to markdown rendering", () => {
  it("should apply theme from theme$ signal as data-color-mode on the markdown wrapper", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-theme",
          ...THREAD_BASE,
          chatMessages: [
            {
              role: "assistant",
              content: "hello",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-theme" });

    await waitFor(() => {
      expect(screen.getByText("hello")).toBeInTheDocument();
    });

    context.store.set(setTheme$, "dark");

    await waitFor(() => {
      expect(
        document.querySelector('[data-color-mode="dark"]'),
      ).toBeInTheDocument();
    });

    context.store.set(setTheme$, "light");

    await waitFor(() => {
      expect(
        document.querySelector('[data-color-mode="light"]'),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-d-066: markdown links open in new tab", () => {
  it("should render links with target=_blank and rel=noopener noreferrer", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-link",
          ...THREAD_BASE,
          chatMessages: [
            {
              role: "assistant",
              content: "[example](https://example.com)",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-link" });

    await waitFor(() => {
      const link = screen.getAllByRole("link").find((el) => {
        return /example/.test(el.textContent ?? "");
      });
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });
});
