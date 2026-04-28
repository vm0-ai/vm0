import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  mockUploadPending,
  mockUploadSuccess,
} from "../../../mocks/upload-helpers.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockChatAPI() {
  server.use();
}

// ---------------------------------------------------------------------------
// CHAT-D-056: File type icons render based on getFileTypeIcon(filename)
// ---------------------------------------------------------------------------

describe("chat-d-056: file type icon renders based on getFileTypeIcon", () => {
  it("renders a pdf preview card for pdf attachment in chat message", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            '[Attached file: document.pdf](https://example.com/document.pdf)\nDownload with: curl -sL -o "document.pdf" "https://example.com/document.pdf"',
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("renders generic file icon for unknown file extension", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            '[Attached file: archive.zip](https://example.com/archive.zip)\nDownload with: curl -sL -o "archive.zip" "https://example.com/archive.zip"',
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      const link = document.querySelector('a[download="archive.zip"]');
      expect(link).toBeInTheDocument();
      expect(
        link?.querySelector('img[aria-hidden="true"]'),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-D-057: Upload progress indicator renders for AttachmentChip
// ---------------------------------------------------------------------------

describe("chat-d-057: upload progress indicator in AttachmentChip", () => {
  it("shows progress indicator while upload is pending", async () => {
    const user = userEvent.setup();

    server.use(
      ...mockUploadPending(context, {
        id: "upload-pending",
        filename: "document.pdf",
        contentType: "application/pdf",
        size: 4,
        url: "https://example.com/document.pdf",
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["data"], "document.pdf", {
      type: "application/pdf",
    });
    await user.upload(fileInput!, file);

    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload document.pdf"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-D-058: Image preview thumbnails render in AttachmentChips
// ---------------------------------------------------------------------------

describe("chat-d-058: image preview thumbnails in AttachmentChip", () => {
  it("shows image thumbnail after upload completes", async () => {
    const user = userEvent.setup();
    const imageUrl = "https://example.com/photo.png";

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "photo.png", { type: "image/png" });
    await user.upload(fileInput!, file);

    await waitFor(() => {
      const thumbnailImg = document.querySelector<HTMLImageElement>(
        `img[src="${imageUrl}"]`,
      );
      expect(thumbnailImg).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-059: Image preview button opens lightbox with setLightboxUrlFn
// ---------------------------------------------------------------------------

describe("chat-i-059: image preview button opens lightbox", () => {
  it("opens lightbox when clicking the image chip button", async () => {
    const user = userEvent.setup();
    const imageUrl = "https://example.com/photo.png";

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["img"], "photo.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-060: Close button on lightbox calls closeLightbox
// ---------------------------------------------------------------------------

describe("chat-i-060: close button closes lightbox", () => {
  it("closes lightbox when clicking the Close button", async () => {
    const user = userEvent.setup();
    const imageUrl = "https://example.com/photo.png";

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["img"], "photo.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-061: Backdrop click on lightbox closes it
// ---------------------------------------------------------------------------

describe("chat-i-061: backdrop click closes lightbox", () => {
  it("closes lightbox when clicking the backdrop", async () => {
    const user = userEvent.setup();
    const imageUrl = "https://example.com/photo.png";

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["img"], "photo.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Click the dialog backdrop (the dialog element itself, not a child)
    const dialog = screen.getByRole("dialog");
    click(dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-066: Lightbox download fallback stays in-page and forces attachment
// ---------------------------------------------------------------------------

describe("chat-i-066: lightbox download fallback uses direct download", () => {
  it("appends download=1 and avoids opening a new tab", async () => {
    const user = userEvent.setup();
    const imageUrl = "http://localhost:3000/f/user-1/file-1/photo.png";
    server.use(
      http.get(imageUrl, ({ request }) => {
        if (new URL(request.url).searchParams.get("download") === "1") {
          return HttpResponse.error();
        }
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    let clickedHref = "";
    let clickedDownload = "";
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedHref = this.href;
        clickedDownload = this.download;
      });

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["img"], "photo.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open image preview for photo.png"));

    const downloadButton = await waitFor(() => {
      return screen.getByLabelText("Download");
    });
    click(downloadButton);

    await waitFor(() => {
      expect(anchorClickSpy).toHaveBeenCalledOnce();
    });

    expect(clickedHref).toBe(`${imageUrl}?download=1`);
    expect(clickedDownload).toBe("photo.png");
    expect(openSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-062: Remove button on attachment chips calls onRemove
// ---------------------------------------------------------------------------

describe("chat-i-062: remove button on attachment chip calls onRemove", () => {
  it("removes attachment chip when clicking the Remove button", async () => {
    const user = userEvent.setup();

    server.use(
      ...mockUploadSuccess({
        id: "upload-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 512,
        url: "https://example.com/report.pdf",
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["data"], "report.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove report.pdf")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Remove report.pdf"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Remove report.pdf"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-D-063: Preview buttons render for previewable file attachments
// ---------------------------------------------------------------------------

describe("chat-d-063: preview button renders for previewable file attachment", () => {
  it("renders a preview button for file attachments in sent messages", async () => {
    const fileUrl = "https://example.com/report.pdf";
    const filename = "report.pdf";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: ${filename}](${fileUrl})\nDownload with: curl -sL -o "${filename}" "${fileUrl}"`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Open pdf preview for ${filename}`),
      ).toBeInTheDocument();
    });
  });

  it("renders a preview button from the structured attachFiles field", async () => {
    const fileUrl = "http://localhost:3000/f/user-1/file-1/spec.pdf";
    const filename = "spec.pdf";

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Please review",
          createdAt: "2026-03-10T00:00:00Z",
          attachFiles: [
            {
              id: "file-struct-1",
              filename,
              contentType: "application/pdf",
              size: 4096,
              url: fileUrl,
            },
          ],
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Open pdf preview for ${filename}`),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-D-064: Video attachment chip uses the video branch (not image/file icon)
// Covers the video branch added to AttachmentChip in #9662.
// ---------------------------------------------------------------------------

describe("chat-d-064: video attachment chip shows neither image thumbnail nor file-type icon", () => {
  it("renders composer chip without image preview or file-type icon for an mp4 upload", async () => {
    const user = userEvent.setup();
    const videoUrl = "https://example.com/demo.mp4";

    server.use(
      ...mockUploadSuccess({
        id: "upload-video-1",
        filename: "demo.mp4",
        contentType: "video/mp4",
        size: 2048,
        url: videoUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["v"], "demo.mp4", { type: "video/mp4" }),
    );

    // Wait for the chip's Remove button, which appears only after the
    // attachment has been added to the draft.
    await waitFor(() => {
      expect(screen.getByLabelText("Remove demo.mp4")).toBeInTheDocument();
    });

    const chipDiv = document.querySelector<HTMLElement>('[title="demo.mp4"]');
    expect(chipDiv).toBeInTheDocument();

    // Image branch would render an <img> with src=videoUrl; video branch must not.
    expect(
      document.querySelector(`img[src="${videoUrl}"]`),
    ).not.toBeInTheDocument();
    // File branch would render an aria-hidden file-type icon <img>; video must not.
    expect(
      chipDiv?.querySelector('img[aria-hidden="true"]'),
    ).not.toBeInTheDocument();
  });
});

describe("chat-d-064: audio attachment chip shows audio file icon", () => {
  it("renders composer chip without image preview or file-type icon for an mp3 upload", async () => {
    const user = userEvent.setup();
    const audioUrl = "https://example.com/clip.mp3";

    server.use(
      ...mockUploadSuccess({
        id: "upload-audio-1",
        filename: "clip.mp3",
        contentType: "audio/mpeg",
        size: 2048,
        url: audioUrl,
      }),
    );
    mockChatAPI();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["a"], "clip.mp3", { type: "audio/mpeg" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove clip.mp3")).toBeInTheDocument();
    });

    const chipDiv = document.querySelector<HTMLElement>('[title="clip.mp3"]');
    expect(chipDiv).toBeInTheDocument();
    expect(
      document.querySelector(`img[src="${audioUrl}"]`),
    ).not.toBeInTheDocument();
    expect(
      chipDiv?.querySelector('img[aria-hidden="true"]'),
    ).not.toBeInTheDocument();
    expect(chipDiv?.querySelector("svg")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-065: sendNewThreadMessage$ forwards uploaded attachments as
// structured `attachFiles` in the first-message POST (fixes #10243 for the
// /agents/:agentId/chat new-thread entry point).
// ---------------------------------------------------------------------------

describe("chat-i-065: new-thread send includes structured attachFiles", () => {
  it("posts attachFiles when the first message carries an uploaded file", async () => {
    const user = userEvent.setup();
    const fileUrl = "https://example.com/notes.pdf";
    let capturedAttachFiles: unknown = "not-called";

    server.use(
      ...mockUploadSuccess({
        id: "upload-new-1",
        filename: "notes.pdf",
        contentType: "application/pdf",
        size: 321,
        url: fileUrl,
      }),
    );
    mockChatLifecycle();
    // Register AFTER mockChatLifecycle so this handler matches first and can
    // capture the request body before the lifecycle mock responds.
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedAttachFiles = body.attachFiles;
        return respond(201, {
          runId: "run-new-1",
          threadId: "thread-test-1",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      fileInput!,
      new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove notes.pdf")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Please review");

    await waitFor(() => {
      // size is sourced from the client File (3 bytes for "pdf"), not the
      // upload response — the important assertion is that attachFiles is
      // populated with the uploaded id.
      expect(capturedAttachFiles).toStrictEqual([
        {
          id: "upload-new-1",
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 3,
        },
      ]);
    });
  });
});
