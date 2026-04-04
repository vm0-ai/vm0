import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";
const THREAD_ID = "thread-test-1";

function mockSubagentThread() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: DEFAULT_AGENT_ID,
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: SUB_AGENT_ID,
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: THREAD_ID,
        title: null,
        agentId: SUB_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

// CHAT-S-044: Sending state affects ChatThreadComposer button display
describe("zero chat thread page - sending state affects composer button display", () => {
  it("shows Stop button while sending and Send button after run completes (CHAT-S-044)", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    mockSubagentThread();

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const link = await waitFor(() => {
      return screen.getByRole("link", { name: "View agent profile" });
    });

    await user.click(link);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUB_AGENT_ID}`);
    });
  });
});

// CHAT-I-046: Pin button calls handlePin on click in thread
describe("zero chat thread page - pin button toggles pin state", () => {
  it("pin button disappears after click when agent is added to pinned list (CHAT-I-046)", async () => {
    const user = userEvent.setup();
    setMockUserPreferences({ pinnedAgentIds: [] });
    mockSubagentThread();

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const pinButton = await waitFor(() => {
      return screen.getByLabelText("Pin to sidebar");
    });

    await user.click(pinButton);

    await waitFor(() => {
      expect(screen.queryByLabelText("Pin to sidebar")).not.toBeInTheDocument();
    });
  });
});

// CHAT-N-047: Sub-agents Link navigates to /agents
describe("zero chat thread page - sub-agents link navigation", () => {
  it("navigates to /agents when Sub-agents link is clicked (CHAT-N-047)", async () => {
    const user = userEvent.setup();
    mockSubagentThread();

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "Sub-agents" }),
      ).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: "Sub-agents" });
    await user.click(link);

    await waitFor(() => {
      expect(pathname()).toBe("/agents");
    });
  });
});

// CHAT-N-048: Schedule button navigates to agent with schedule tab
describe("zero chat thread page - schedule button navigation", () => {
  it("navigates to /agents/:id with tab=schedule when schedule button is clicked (CHAT-N-048)", async () => {
    const user = userEvent.setup();
    mockSubagentThread();

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Scheduled")).toBeInTheDocument();
    });

    const scheduleButton = screen.getByLabelText("Scheduled");
    await user.click(scheduleButton);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUB_AGENT_ID}`);
      expect(search()).toContain("tab=schedule");
    });
  });
});

// CHAT-I-049 / CHAT-I-050: Image preview button opens ImageLightbox
describe("zero chat thread page - image attachment opens lightbox", () => {
  it("clicking image preview button opens ImageLightbox (CHAT-I-049, CHAT-I-050)", async () => {
    const user = userEvent.setup();
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

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "photo.png" }),
      ).toBeInTheDocument();
    });

    const imageButton = screen
      .getByRole("img", { name: "photo.png" })
      .closest("button")!;
    await user.click(imageButton);

    await waitFor(() => {
      const lightboxImg = screen.getAllByRole("img").find((img) => {
        return (
          (img as HTMLImageElement).src === "https://example.com/photo.png"
        );
      });
      expect(lightboxImg).toBeInTheDocument();
    });
  });
});

// CHAT-I-051: Timeline expansion button toggles expandedIds
describe("zero chat thread page - timeline expansion button", () => {
  it("clicking Took N steps button expands and shows timeline summaries (CHAT-I-051)", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Run something",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Done",
          summaries: [{ kind: "tool", name: "Bash", input: { command: "ls" } }],
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const expandButton = await waitFor(() => {
      return screen.getByText(/Took 1 step/);
    });

    // Timeline items are collapsed initially - the step text is not visible
    expect(screen.queryByText("Running a command...")).not.toBeInTheDocument();

    await user.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText("Running a command...")).toBeInTheDocument();
    });
  });
});

// CHAT-I-052: Copy message button calls copyMessage signal
describe("zero chat thread page - copy message button", () => {
  it("clicking copy button shows copied state after writing to clipboard (CHAT-I-052)", async () => {
    const user = userEvent.setup();
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

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    const copyButton = screen.getByLabelText("Copy message");
    await user.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello world");
    });
  });
});

// CHAT-N-053: View activity logs Link navigates to /activities/:id
describe("zero chat thread page - view activity logs link", () => {
  it("navigates to /activities/:id when view run logs link is clicked (CHAT-N-053)", async () => {
    const user = userEvent.setup();
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

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    const logLink = screen.getByRole("link", { name: "View run logs" });
    await user.click(logLink);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-legacy-1");
    });
  });
});

// CHAT-D-054: Attachment download links render for file attachments
describe("zero chat thread page - file attachment download link", () => {
  it("renders a download link for non-image file attachments (CHAT-D-054)", async () => {
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

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "document.pdf" }),
      ).toBeInTheDocument();
    });
  });
});

// CHAT-I-055: Attachment download links do not navigate away from the page
describe("zero chat thread page - file attachment download does not navigate away", () => {
  it("clicking the download link does not change the pathname (CHAT-I-055)", async () => {
    const user = userEvent.setup();
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

    await setupPage({ context, path: `/chats/${THREAD_ID}` });

    const downloadLink = await waitFor(() => {
      return screen.getByRole("link", { name: "document.pdf" });
    });

    const initialPathname = pathname();
    await user.click(downloadLink);

    await waitFor(() => {
      expect(pathname()).toBe(initialPathname);
    });
  });
});
