import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setTheme$ } from "../../../signals/theme.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";

const context = testContext();
const mockApi = createMockApi(context);

function makeThreadBase() {
  return {
    title: null,
    agentId: "c0000000-0000-4000-a000-000000000001",
    latestSessionId: null,
    activeRunIds: [] as string[],
    draftContent: null,
    draftAttachments: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("chat-d-064: markdown content renders from props", () => {
  it("should parse markdown and render as formatted HTML", async () => {
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "**bold text**",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-markdown",
          ...makeThreadBase(),
        });
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
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "hello",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-theme",
          ...makeThreadBase(),
        });
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

describe("chat-d-067: markdown image URL renders inline", () => {
  it("should render an <img> for image link and hide the plain <a>", async () => {
    const src = "https://example.com/cat.png";
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: `[cat](${src})`,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-img",
          ...makeThreadBase(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-img" });

    await waitFor(() => {
      const img = document.querySelector(`img[src="${src}"]`);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("alt", "cat");
    });
  });
});

describe("chat-d-069: markdown image syntax renders inline thumbnail", () => {
  it("should render ![alt](url) image syntax through the thumbnail override so it matches the link-syntax sizing", async () => {
    const src = "https://example.com/dog.png";
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: `![dog](${src})`,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-img-syntax",
          ...makeThreadBase(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-img-syntax" });

    await waitFor(() => {
      const img = document.querySelector(`img[src="${src}"]`);
      expect(img).toBeInTheDocument();
      // Must carry the thumbnail clamp so image-syntax URLs don't render at
      // natural size (regression from PR #10254 which only overrode <a>).
      expect(img?.className).toContain("max-h-32");
    });
  });
});

describe("chat-d-068: markdown video URL renders inline", () => {
  it("should render a <video controls> for video link", async () => {
    const src = "https://example.com/clip.mp4";
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: `[clip](${src})`,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-video",
          ...makeThreadBase(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-video" });

    await waitFor(() => {
      const video = document.querySelector(`video[src="${src}"]`);
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("controls");
    });
  });
});

describe("chat-d-066: markdown links open in new tab", () => {
  it("should render links with target=_blank and rel=noopener noreferrer", async () => {
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "[example](https://example.com)",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-link",
          ...makeThreadBase(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-link" });

    await waitFor(() => {
      const link = queryAllByRoleFast("link").find((el) => {
        return /example/.test(el.textContent ?? "");
      });
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });
});
