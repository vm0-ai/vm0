import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { hasSubscription } from "../../../mocks/ably.ts";
import { pathname } from "../../../signals/location.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import {
  mockChatLifecycle,
  mockSubagentThread,
  sendMessageInUI,
  PLACEHOLDER,
  SUB_AGENT_ID,
} from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";

// CHAT-S-044: Sending state affects ChatThreadComposer button display
describe("zero chat thread page - sending state affects composer button display", () => {
  it("shows Stop button while sending and Send button after run completes (CHAT-S-044)", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
    });

    // Wait for loadPagedMessages$ to subscribe before completing
    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadMessageCreated:${THREAD_ID}`),
      ).toBeTruthy();
    });

    ctrl.completeRun("Done");

    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});

// CHAT-N-045: Agent avatar Link navigates to /agents/:id
describe("zero chat thread page - agent avatar link navigation", () => {
  it("navigates to /agents/:id when avatar link is clicked (CHAT-N-045)", async () => {
    mockSubagentThread(THREAD_ID);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    // Wait for the chat page to be fully rendered before interacting
    const link = await waitFor(() => {
      const el = screen.getByLabelText("View agent profile");
      // Verify the link has a non-empty href (agent data resolved)
      expect(el).toHaveAttribute("href", `/agents/${SUB_AGENT_ID}`);
      return el;
    });

    click(link);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUB_AGENT_ID}`);
    });
  });
});

// CHAT-I-046: Pin button calls handlePin on click in thread
describe("zero chat thread page - pin button toggles pin state", () => {
  it("pin button disappears after click when agent is added to pinned list (CHAT-I-046)", async () => {
    setMockUserPreferences({ pinnedAgentIds: [] });
    mockSubagentThread(THREAD_ID);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const pinButton = await waitFor(() => {
      return screen.getByLabelText("Pin to sidebar");
    });

    click(pinButton);

    await waitFor(() => {
      expect(screen.queryByLabelText("Pin to sidebar")).not.toBeInTheDocument();
    });
  });
});

// CHAT-I-049 / CHAT-I-050: Image preview button opens ImageLightbox
describe("zero chat thread page - image attachment opens lightbox", () => {
  it("clicking image preview button opens ImageLightbox (CHAT-I-049, CHAT-I-050)", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: photo.png](https://example.com/photo.png)\nDownload with: curl https://example.com/photo.png\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "photo.png" }),
      ).toBeInTheDocument();
    });

    const imageButton = screen
      .getByRole("img", { name: "photo.png" })
      .closest("button")!;
    click(imageButton);

    await waitFor(() => {
      const lightboxImg = screen.getAllByRole("img").find((img) => {
        return (
          (img as HTMLImageElement).src === "https://example.com/photo.png"
        );
      });
      expect(lightboxImg).toBeInTheDocument();
    });
  });

  it("downloads a CDN image from the lightbox", async () => {
    const imageUrl = "https://cdn.example.com/photo.png";
    server.use(
      http.get(imageUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: photo.png](${imageUrl})\nDownload with: curl ${imageUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const imageButton = await waitFor(() => {
      return screen.getByRole("img", { name: "photo.png" }).closest("button")!;
    });
    click(imageButton);

    const downloadButton = await waitFor(() => {
      return screen.getByLabelText("Download");
    });
    click(downloadButton);

    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
      expect(anchorClickSpy).toHaveBeenCalledWith();
    });
  });
});

// CHAT-I-052: Copy message button writes message content to clipboard
describe("zero chat thread page - copy message button", () => {
  it("clicking copy button writes message content to clipboard (CHAT-I-052)", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Hello world",
          runId: "run-legacy-1",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    const assistantBubble = screen
      .getByText("Hello world")
      .closest("[data-role='assistant']")!;
    const copyButton = within(assistantBubble as HTMLElement).getByLabelText(
      "Copy message",
    );
    click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello world");
    });

    // The message should still be visible after copying (page remains stable)
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });
});

// CHAT-N-053: View activity logs Link navigates to /activities/:id
describe("zero chat thread page - view activity logs link", () => {
  it("navigates to /activities/:id when view run logs link is clicked (CHAT-N-053)", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Hello world",
          runId: "run-legacy-1",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    const logLink = screen.getByLabelText("View run logs");
    click(logLink);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-legacy-1");
    });
  });
});

// CHAT-I-055: Attachment download links do not navigate away from the page
describe("zero chat thread page - file attachment download does not navigate away", () => {
  it("clicking the download link does not change the pathname (CHAT-I-055)", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: document.pdf](https://example.com/document.pdf)\nDownload with: curl https://example.com/document.pdf\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const downloadLink = await waitFor(() => {
      return screen.getByTitle("document.pdf");
    });

    const initialPathname = pathname();
    click(downloadLink);

    await waitFor(() => {
      expect(pathname()).toBe(initialPathname);
    });
  });
});
