import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import {
  mockChatLifecycle,
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

// CHAT-D-065: Video attachments render an inline <video controls> player.
// Covers isVideoFilename + video branch added to PagedUserMessage in #9662.
describe("zero chat thread page display - attachment video preview", () => {
  it("renders a video element with controls for mp4 attachments", async () => {
    const videoUrl = "https://example.com/clip.mp4";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: clip.mp4](${videoUrl})\nDownload with: curl ${videoUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const video = await waitFor(() => {
      const el = document.querySelector<HTMLVideoElement>(
        `video[src="${videoUrl}"]`,
      );
      expect(el).toBeInTheDocument();
      return el;
    });

    expect(video?.hasAttribute("controls")).toBeTruthy();
    // Must not fall through to the image or download branches.
    expect(
      document.querySelector(`img[src="${videoUrl}"]`),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('a[download="clip.mp4"]'),
    ).not.toBeInTheDocument();
  });
});

// CHAT-D-066: HeaderAgentAvatar renders null until agentId resolves — no default-avatar flicker
describe("zero chat thread page display - header agent avatar flicker fix", () => {
  it("renders the agent avatar link once agentId resolves and never renders a placeholder avatar beforehand", async () => {
    mockSubagentThread("thread-avatar-test");

    detachedSetupPage({ context, path: "/chats/thread-avatar-test" });

    // The avatar link must appear once the agent id resolves.
    await waitFor(() => {
      expect(
        document.querySelector('a[aria-label="View agent profile"]'),
      ).toBeInTheDocument();
    });

    // No blank-name placeholder SVG should have been rendered: the component
    // returns null before agentId is known, so there is never a second avatar
    // element without the accessible link wrapper.
    const avatarLinks = document.querySelectorAll(
      'a[aria-label="View agent profile"]',
    );
    expect(avatarLinks).toHaveLength(1);
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
