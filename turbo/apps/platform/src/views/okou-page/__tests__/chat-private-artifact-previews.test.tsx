import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow, now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const START = Date.parse("2026-09-09T00:00:00.000Z");
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const FIRST_URL = "https://private-r2.example/photo.png?signature=first";
const NEXT_URL = "https://private-r2.example/photo.png?signature=next";

function mockPrivateImage(content?: string) {
  const canonical = artifactReferencePath(FILE_ID, "photo.png");
  mockNow(START, context.signal);
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
    responseUrl =
      url === FIRST_URL
        ? NEXT_URL
        : "https://private-r2.example/photo.png?signature=unexpected";
    return respond(200, {
      url,
      expiresAt: new Date(now() + TWO_DAYS).toISOString(),
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

test("reuse valid credentials, renew an expired lightbox, and preserve the loaded thread image", async () => {
  mockPrivateImage();
  const visibility = context.mocks.browser.visibilityState("visible");
  const image = await openChat();
  fireEvent.load(image);

  click(image);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", FIRST_URL);
  await closePreview();

  // The page stays mounted beyond the signature's lifetime. Neither elapsed
  // time nor returning to the tab should replace successful displays.
  mockNow(START + TWO_DAYS + 1000, context.signal);
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  expect(image).toHaveAttribute("src", FIRST_URL);
  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      NEXT_URL,
    );
  });
  expect(image).toHaveAttribute("src", FIRST_URL);
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();
});

test("renew a nearly expired credential when opening a new display", async () => {
  mockPrivateImage();
  const image = await openChat();
  mockNow(START + TWO_DAYS - 4 * 60 * 1000, context.signal);
  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      NEXT_URL,
    );
  });
  expect(image).toHaveAttribute("src", FIRST_URL);
});

test("retry an expired lazy image once and keep ordinary load failures bounded", async () => {
  mockPrivateImage();
  const image = await openChat();
  mockNow(START + TWO_DAYS + 1000, context.signal);
  fireEvent.error(image);
  await waitFor(() => {
    expect(screen.getByAltText("photo.png")).toHaveAttribute("src", NEXT_URL);
  });

  // A failed replacement must settle as an error, without a renewal loop.
  const replacement = screen.getByAltText("photo.png");
  mockNow(START + 2 * TWO_DAYS + 2000, context.signal);
  fireEvent.error(replacement);
  expect(screen.getByTestId("markdown-image-preview-loading")).toBeVisible();
  expect(replacement).toHaveAttribute("src", NEXT_URL);
});

test("share one in-flight credential between repeated thread images and their preview", async () => {
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
  ).resolves.toHaveAttribute("src", FIRST_URL);
});

test("downloads obtain a fresh credential without replacing the open image", async () => {
  mockPrivateImage();
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(
    "https://private-r2.example/photo.png",
    ({ request }) => {
      expect(request.cache).toBe("default");
      return new URL(request.url).searchParams.get("signature") === "next"
        ? HttpResponse.text("private image bytes")
        : new HttpResponse(null, { status: 403 });
    },
  );
  const image = await openChat();
  click(image);
  const preview = await screen.findByTestId("attachment-lightbox-image");
  expect(preview).toHaveAttribute("src", FIRST_URL);
  mockNow(START + TWO_DAYS + 1000, context.signal);
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(downloads.downloads[0]?.filename).toBe("photo.png");
  });
  expect(preview).toHaveAttribute("src", FIRST_URL);
  expect(image).toHaveAttribute("src", FIRST_URL);
});

test("an expired video range read renews its credential and restores the playback position", async () => {
  const firstVideoUrl = "https://private-r2.example/clip.mp4?signature=first";
  const nextVideoUrl = "https://private-r2.example/clip.mp4?signature=next";
  const canonical = artifactReferencePath(FILE_ID, "clip.mp4");
  mockNow(START, context.signal);
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("clip.mp4", {
        id: FILE_ID,
        contentType: "video/mp4",
        url: canonical,
      }),
    ],
    chatEvents: [
      {
        id: "private-video-message",
        role: "assistant",
        content: `[clip.mp4](${canonical})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "private-video-event",
        sequenceNumber: 1,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: now() === START ? firstVideoUrl : nextVideoUrl,
      expiresAt: new Date(now() + TWO_DAYS).toISOString(),
      filename: "clip.mp4",
      contentType: "video/mp4",
      target: { kind: "file", id: FILE_ID },
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("clip.mp4"));
  const video = await screen.findByLabelText(/^Video preview for /);
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("Expected video preview");
  }
  await waitFor(() => {
    expect(video).toHaveAttribute("src", firstVideoUrl);
  });
  video.currentTime = 42;
  mockNow(START + TWO_DAYS + 1000, context.signal);
  fireEvent.error(video);
  await waitFor(() => {
    expect(video).toHaveAttribute("src", nextVideoUrl);
  });
  video.currentTime = 0;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(42);
});
