import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactFile,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile>,
): ChatThreadArtifactFile {
  return {
    id: "artifact-image",
    filename: "image.png",
    contentType: "image/png",
    size: 1024,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced", accountReady: true },
    ...overrides,
  };
}

function queryButtonByName(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function getButtonByName(name: string): HTMLElement {
  const button = queryButtonByName(name);
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test("The image viewer navigates across one assistant response", async () => {
  const firstImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
  const secondImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
  const runId = "run-body-image-split-navigation";
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [
        {
          runId,
          files: [
            artifactFile(firstImageUrl, {
              id: "artifact-body-split-first-image",
              filename: "first.png",
            }),
            artifactFile(secondImageUrl, {
              id: "artifact-body-split-second-image",
              filename: "second.png",
            }),
          ],
        },
      ],
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "msg-body-image-split-label",
        role: "assistant",
        content: "Generated images:",
        runId,
        runEventId: "event:0",
        sequenceNumber: 0,
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-body-image-split-first",
        role: "assistant",
        content: `1. ![first.png](${firstImageUrl})`,
        runId,
        runEventId: "event:1",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: "msg-body-image-split-second",
        role: "assistant",
        content: `2. ![second.png](${secondImageUrl})`,
        runId,
        runEventId: "event:2",
        sequenceNumber: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const firstImage = await screen.findByAltText("first.png");
  const previewButton = firstImage.closest<HTMLElement>("button");
  if (!previewButton) {
    throw new Error("Expected the first generated image to open a preview");
  }
  fireEvent.load(firstImage);
  click(previewButton);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "first.png",
    );
  });
  expect(queryButtonByName("Previous image artifact")).toBeUndefined();
  const nextImage = await waitFor(() => {
    return getButtonByName("Next image artifact");
  });

  click(nextImage);

  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "second.png",
    );
  });
});
