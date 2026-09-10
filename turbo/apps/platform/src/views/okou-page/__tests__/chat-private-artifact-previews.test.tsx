import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedMenuItem,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const FIRST_URL = "https://private-r2.example/photo.png?signature=first";
const NEXT_URL = "https://private-r2.example/photo.png?signature=next";
const THIRD_URL = "https://private-r2.example/photo.png?signature=third";

function mockPrivateImage(content?: string) {
  const canonical = artifactReferencePath(FILE_ID, "photo.png");
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("photo.png", {
        id: FILE_ID,
        contentType: "image/png",
        url: canonical,
      }),
    ],
    chatEvents: [
      {
        id: "private-preview-message",
        role: "assistant",
        content: content ?? `![photo.png](${canonical})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "private-preview-event",
        sequenceNumber: 1,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
    ],
  });
  let responseUrl = FIRST_URL;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = responseUrl;
    responseUrl = url === FIRST_URL ? NEXT_URL : THIRD_URL;
    return respond(200, {
      url,
      expiresAt: "2026-09-11T00:00:00.000Z",
      filename: "photo.png",
      contentType: "image/png",
      target: { kind: "file", id: FILE_ID },
    });
  });
}

async function openChat() {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", FIRST_URL);
  });
  return image;
}

async function closePreview() {
  click(await findNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

test("each image preview loads independently and preserves the thread image", async () => {
  mockPrivateImage();
  const image = await openChat();
  fireEvent.load(image);

  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      NEXT_URL,
    );
  });
  await closePreview();

  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      THIRD_URL,
    );
  });
  expect(screen.getByAltText("photo.png")).toHaveAttribute("src", FIRST_URL);
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();
});

test("repeated thread images reuse their artifact while the preview loads independently", async () => {
  const canonical = artifactReferencePath(FILE_ID, "photo.png");
  mockPrivateImage(`![photo.png](${canonical})\n\n![photo.png](${canonical})`);
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const images = await screen.findAllByAltText("photo.png");
  expect(images).toHaveLength(2);
  await waitFor(() => {
    for (const image of images) {
      expect(image).toHaveAttribute("src", FIRST_URL);
    }
  });
  click(images[0]!);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", NEXT_URL);
});

test("downloads obtain a fresh credential without replacing the open image", async () => {
  mockPrivateImage();
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(
    "https://private-r2.example/photo.png",
    ({ request }) => {
      expect(request.cache).toBe("default");
      return new URL(request.url).searchParams.get("signature") === "third"
        ? HttpResponse.text("private image bytes")
        : new HttpResponse(null, { status: 403 });
    },
  );
  const image = await openChat();
  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      NEXT_URL,
    );
  });
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(downloads.downloads[0]?.filename).toBe("photo.png");
  });
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "src",
    NEXT_URL,
  );
  expect(image).toHaveAttribute("src", FIRST_URL);
});
