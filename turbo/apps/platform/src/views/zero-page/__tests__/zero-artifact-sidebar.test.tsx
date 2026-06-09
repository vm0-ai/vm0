import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000040";
const THREAD_PATH = `/chats/${THREAD_ID}`;

function setupChatThread({
  artifactFiles,
  content,
  path = THREAD_PATH,
}: {
  artifactFiles?: ChatThreadArtifactFile[];
  content: string;
  path?: string;
}): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  const messages: PagedChatMessage[] = [
    {
      id: "msg-artifact-user",
      role: "user",
      content: "Show me the artifact",
      runId: "run-artifact",
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-artifact-assistant",
      role: "assistant",
      content,
      runId: "run-artifact",
      status: "completed",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-artifact-completed",
      role: "assistant",
      content: null,
      runId: "run-artifact",
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: null,
      agentId: AGENT_ID,
      latestSessionId: null,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId || query.beforeId) {
      return respond(200, { messages: [] });
    }
    return respond(200, { messages, hasHistoryBefore: false });
  });
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
    });
  });
  if (artifactFiles) {
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [{ runId: "run-artifact", files: artifactFiles }],
      });
    });
  }

  detachedSetupPage({ context, path });
}

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-release-notes",
    filename: "release-notes.md",
    contentType: "text/markdown",
    size: 42,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

function getArtifactTab(container: HTMLElement, label: string): HTMLElement {
  const tab = queryAllByRoleFast("tab", container).find((element) => {
    return element.textContent?.trim() === label;
  });
  if (!tab) {
    throw new Error(`${label} artifact tab not found`);
  }
  return tab;
}

describe("zero artifact sidebar", () => {
  it("opens document previews from chat, moves them into split view, and closes the pane", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({ content: `[Release notes](${markdownUrl})` });

    const preview = await waitFor(() => {
      return screen.getByTestId("attachment-preview-markdown");
    });

    await user.click(preview);
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open in split view"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Close artifact"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });

  it("keeps image sidebar zoom controls bounded and resettable", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl =
      "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/photo.png";
    setupChatThread({
      content: `[photo](${imageUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(imageUrl)}`,
    });

    const zoomLevel = await waitFor(() => {
      return screen.getByTestId("artifact-sidebar-image-zoom-level");
    });
    const zoomIn = screen.getByTestId("artifact-sidebar-image-zoom-in");
    const zoomOut = screen.getByTestId("artifact-sidebar-image-zoom-out");

    expect(zoomLevel).toHaveTextContent("100%");
    await user.click(zoomIn);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(zoomOut);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });

    await user.click(zoomIn);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(screen.getByTestId("artifact-sidebar-image-reset-zoom"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });
  });

  it("shares an artifact and exposes download destinations from the sidebar", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.connectors([]);
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({
      artifactFiles: [artifactFile(markdownUrl)],
      content: `[Release notes](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Share artifact"));
    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));

    await waitFor(() => {
      expect(screen.getByText("Download")).toBeInTheDocument();
      expect(screen.getByText("Connect Google Drive")).toBeInTheDocument();
    });
  });

  it("browses artifact inbox sections, searches, and opens a result", async () => {
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    const imageUrl =
      "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/chart.png";
    context.mocks.http.get(markdownUrl, () => {
      return new Response(
        "# Release notes\n\nOpened from the artifact inbox.",
        {
          headers: { "Content-Type": "text/plain" },
        },
      );
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(markdownUrl),
        artifactFile(imageUrl, {
          id: "artifact-chart",
          filename: "launch-chart.png",
          contentType: "image/png",
          size: 128,
        }),
      ],
      content: "Artifacts are ready.",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Open artifacts")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open artifacts"));

    const inbox = await waitFor(() => {
      const element = screen.getByTestId("artifact-inbox");
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
      expect(screen.getByText("launch-chart.png")).toBeInTheDocument();
      return element;
    });

    click(getArtifactTab(inbox, "Media"));

    await waitFor(() => {
      expect(screen.getByText("launch-chart.png")).toBeInTheDocument();
      expect(screen.queryByText("release-notes.md")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Search artifacts"));
    await fill(screen.getByPlaceholderText("Search"), "release");

    await waitFor(() => {
      expect(
        screen.getByText("No artifacts match this view."),
      ).toBeInTheDocument();
    });

    click(getArtifactTab(inbox, "Docs"));

    await waitFor(() => {
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
      expect(screen.queryByText("launch-chart.png")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open artifact release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByText("Opened from the artifact inbox."),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Back to all artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifacts"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });
});
