import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000041";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const GENERATION_ID = "d0000000-0000-4000-a000-000000000099";
const SOURCE_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/source.png";
const EDITED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/edited.png";

function setupChatThread({
  featureSwitches,
  path = `${THREAD_PATH}?artifact=${encodeURIComponent(SOURCE_IMAGE_URL)}`,
}: {
  featureSwitches?: Parameters<typeof detachedSetupPage>[0]["featureSwitches"];
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
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  const messages: PagedChatMessage[] = [
    {
      id: "msg-image-user",
      role: "user",
      content: "Here is the image",
      runId: "run-image",
      createdAt: "2026-03-10T00:00:00Z",
      attachFiles: [
        {
          id: "artifact-image-edit-source",
          filename: "source.png",
          contentType: "image/png",
          size: 128,
          url: SOURCE_IMAGE_URL,
        },
      ],
    },
    {
      id: "msg-image-assistant",
      role: "assistant",
      content: "Image is ready.",
      runId: "run-image",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-image-completed",
      role: "assistant",
      content: null,
      runId: "run-image",
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: null,
      agentId: AGENT_ID,
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
    });
  });

  detachedSetupPage({
    context,
    featureSwitches,
    path,
  });
}

function mockImageEditGeneration(): void {
  context.mocks.api(zeroImageIoGenerateContract.post, ({ respond }) => {
    return respond(202, {
      generationId: GENERATION_ID,
      type: "image",
      status: "queued",
      realtime: {
        channelName: "gen:image",
        eventName: "update",
        tokenRequest: {
          keyName: "test-key",
          timestamp: 0,
          capability: "{}",
          nonce: "test-nonce",
          mac: "test-mac",
        },
      },
    });
  });
  context.mocks.api(zeroBuiltInGenerationContract.get, ({ respond }) => {
    return respond(200, {
      generationId: GENERATION_ID,
      type: "image",
      status: "completed",
      result: { url: EDITED_IMAGE_URL },
      createdAt: "2026-03-10T00:00:00Z",
      startedAt: "2026-03-10T00:00:01Z",
      completedAt: "2026-03-10T00:00:02Z",
    });
  });
}

describe("image editing", () => {
  it("adds a remove-background result for the selected canvas image", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageEditGeneration();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByTestId("image-edit-open"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });
    expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();

    await user.click(screen.getByTestId("artifact-sidebar-body-image"));

    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("image-edit-remove-background")).toHaveAttribute(
      "aria-label",
      "Remove background",
    );
    expect(screen.getByTestId("image-edit-enhance")).toHaveAttribute(
      "aria-label",
      "Enhance",
    );
    expect(screen.getByTestId("image-edit-download")).toHaveAttribute(
      "aria-label",
      "Download",
    );

    await user.click(screen.getByTestId("image-edit-remove-background"));

    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });
  });

  it("hides the edit action when the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({});

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    expect(screen.queryByTestId("image-edit-open")).toBeNull();
  });

  it("ignores image edit mode from the URL when the feature switch is off", async () => {
    setupChatThread({
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(SOURCE_IMAGE_URL)}&artifact-image-edit=1`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    expect(
      screen.queryByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeNull();
    expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
  });

  it("keeps fullscreen when opening image edit from a fullscreen lightbox", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(
      within(screen.getByTestId("attachment-lightbox")).getByLabelText(
        "Enter fullscreen",
      ),
    );
    await user.click(screen.getByTestId("image-edit-open"));

    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Share artifact")).toBeNull();
    expect(screen.queryByLabelText("Download artifact")).toBeNull();

    await user.click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );

    await user.click(screen.getByLabelText("Enter fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
  });

  it("moves and duplicates the selected image on the edit canvas", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByTestId("image-edit-open"));

    const image = screen.getByTestId("artifact-sidebar-body-image");
    fireEvent.pointerDown(image, { button: 0, clientX: 100, clientY: 100 });
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 140 });
    fireEvent.pointerUp(window);

    expect(image).toHaveStyle({ left: "470px", top: "370px" });

    fireEvent.keyDown(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
      {
        key: "c",
        metaKey: true,
      },
    );
    fireEvent.keyDown(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
      {
        key: "v",
        metaKey: true,
      },
    );

    expect(
      screen.getByTestId("artifact-sidebar-body-image-copy"),
    ).toHaveAttribute("src", SOURCE_IMAGE_URL);
  });
});
