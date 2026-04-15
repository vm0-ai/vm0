import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import {
  mockChatLifecycle,
  makeToolUseEvent,
  mockSubagentThread,
  SUB_AGENT_ID,
} from "./chat-test-helpers.ts";

const context = testContext();

// CHAT-D-033: Pin pill renders conditionally in ChatThreadHeader
describe("zero chat thread page display - pin pill conditional rendering", () => {
  it("shows pin pill when agent is not pinned", async () => {
    setMockUserPreferences({ pinnedAgentIds: [] });
    mockSubagentThread("thread-header-test");

    detachedSetupPage({ context, path: "/chats/thread-header-test" });

    await waitFor(() => {
      expect(screen.getByLabelText("Pin to sidebar")).toBeInTheDocument();
    });
  });

  it("does not show pin pill when agent is already pinned", async () => {
    setMockUserPreferences({ pinnedAgentIds: [SUB_AGENT_ID] });
    mockSubagentThread("thread-header-test");

    detachedSetupPage({ context, path: "/chats/thread-header-test" });

    await waitFor(() => {
      const spans = screen.getAllByText("Assistant");
      expect(spans.length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText("Pin to sidebar")).not.toBeInTheDocument();
  });
});

// CHAT-D-036: Attachment image previews render in ChatMessageRow
describe("zero chat thread page display - attachment image preview", () => {
  it("renders image attachment preview with the correct alt text", async () => {
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

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "photo.png" }),
      ).toBeInTheDocument();
    });
  });
});

// CHAT-D-037: Attachment file previews render in ChatMessageRow
describe("zero chat thread page display - attachment file preview", () => {
  it("renders file attachment chip with a download link for non-image files", async () => {
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

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf")).toBeInTheDocument();
    });
  });
});

// CHAT-D-038: Run activity line renders summaries
describe("zero chat thread page display - run activity line summaries", () => {
  it("displays a tool-use summary in the run activity line", async () => {
    const ctrl = mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Do task",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    ctrl.setEvents([makeToolUseEvent("Bash", { command: "ls" }, 1)]);

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Current activity")).toBeInTheDocument();
    });
  });
});

// CHAT-D-039: Run activity line renders queue position
describe("zero chat thread page display - run activity line queue position", () => {
  it("displays an in-queue message with position info", async () => {
    const ctrl = mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Do task",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "queued",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(3);

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const el = screen.getByText((_content, element) => {
        return (
          element?.tagName === "P" &&
          (element.textContent?.includes("In queue") ?? false)
        );
      });
      expect(el).toBeInTheDocument();
    });
  });
});

// CHAT-D-043: Message status indicators render in ChatMessageRow
describe("zero chat thread page display - message status indicators", () => {
  it("displays a Stop button status indicator when a run is active", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });
});
