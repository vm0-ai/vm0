import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "@vm0/ui/components/ui/sonner";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
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
import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "../zero-attachment-chips.tsx";

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://www.vm0.ai");
  vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
});

function mockChatAPI() {
  server.use();
}

describe("publicAttachmentUrl", () => {
  it("converts legacy platform file URLs to public CDN artifact URLs", () => {
    expect(
      publicAttachmentUrl(
        "https://www.vm0.ai/f/38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
      ),
    ).toBe(
      "https://cdn.vm7.io/artifacts/user_38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
    );
  });

  it("converts legacy API file URLs when the configured endpoint is web", () => {
    expect(
      publicAttachmentUrl(
        "https://api.vm0.ai/f/38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
      ),
    ).toBe(
      "https://cdn.vm7.io/artifacts/user_38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
    );
  });

  it("converts legacy web file URLs when the configured endpoint is API", () => {
    vi.stubEnv("VITE_API_URL", "https://api.vm0.ai");

    expect(
      publicAttachmentUrl(
        "https://www.vm0.ai/f/38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
      ),
    ).toBe(
      "https://cdn.vm7.io/artifacts/user_38bPAf83mxpw8vvVYy0M6PPTq2B/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png",
    );
  });

  it("keeps external legacy-looking file URLs unchanged", () => {
    const externalUrl =
      "https://example.com/f/user_123/65084eb6-1d42-45ae-9038-c80102d7a4c1/kitten.png";

    expect(publicAttachmentUrl(externalUrl)).toBe(externalUrl);
  });
});

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

  it("renders a compact download chip for unknown file extension", async () => {
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
      const link = screen.getByLabelText("Download archive.zip");
      expect(link).toBeInTheDocument();
      expect(
        within(link).getByTestId("attachment-chip-file-icon"),
      ).toBeInTheDocument();
      expect(within(link).getByText("ZIP")).toBeInTheDocument();
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

  it("shows loading state and supports zoom controls in the image lightbox", async () => {
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

    const image = await screen.findByTestId("attachment-lightbox-image");
    expect(
      screen.getByTestId("attachment-lightbox-image-loading"),
    ).toBeInTheDocument();

    fireEvent.load(image);
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox-image-loading"),
      ).not.toBeInTheDocument();
    });

    expect(screen.getByText("100%")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("125%")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Zoom out"));
    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("125%")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Reset zoom"));
    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "=", metaKey: true });
    await waitFor(() => {
      expect(screen.getByText("125%")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "-", metaKey: true });
    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
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
// CHAT-I-066: Lightbox download fetches blobs instead of opening image URLs
// ---------------------------------------------------------------------------

describe("chat-i-066: lightbox download fetches blobs", () => {
  it("fetches legacy platform file URLs through the public artifact CDN", async () => {
    vi.stubGlobal(
      "location",
      new URL("https://tunnel-yuma-vm0-app.vm7.ai/chats/thread-test-1"),
    );
    const legacyUrl =
      "https://tunnel-yuma-vm0-www.vm7.ai/f/3BennfUepyJwP3OaiYD0rK8CZKs/9c4c6df4-f0ed-4c25-af3a-b58bc40faf0f/image-9c4c6df4.png";
    const cdnUrl =
      "https://cdn.vm7.io/artifacts/user_3BennfUepyJwP3OaiYD0rK8CZKs/9c4c6df4-f0ed-4c25-af3a-b58bc40faf0f/image-9c4c6df4.png";
    let cdnRequests = 0;
    server.use(
      http.get(cdnUrl, () => {
        cdnRequests += 1;
        return HttpResponse.text("img", {
          headers: { "content-type": "image/png" },
        });
      }),
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:download");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function () {
        return;
      });

    try {
      await downloadAttachmentUrl(legacyUrl, context.signal, "image.png");

      expect(cdnRequests).toBe(1);
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
      expect(anchorClickSpy).toHaveBeenCalledOnce();
      expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:download");
    } finally {
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it("does not fall back to opening the image URL when fetch fails", async () => {
    const user = userEvent.setup();
    const imageUrl = "http://localhost:3000/files/user-1/file-1/photo.png";
    server.use(
      http.get(imageUrl, () => {
        return HttpResponse.error();
      }),
    );
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });
    const toastErrorSpy = vi.spyOn(toast, "error").mockImplementation(() => {
      return "" as ReturnType<typeof toast.error>;
    });

    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function () {
        return;
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
      expect(toastErrorSpy).toHaveBeenCalledWith("Download failed");
    });

    expect(anchorClickSpy).not.toHaveBeenCalled();
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
    const fileUrl = "https://cdn.vm7.io/artifacts/user-1/file-1/spec.pdf";
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

  it("posts only fulfilled uploaded attachments when another upload fails", async () => {
    const user = userEvent.setup();
    const okUploadUrl = "https://mock-upload.example.com/ok.txt";
    const failedUploadUrl = "https://mock-upload.example.com/failed.txt";
    let capturedAttachFiles: unknown = "not-called";

    server.use(
      mockApi(zeroUploadsContract.prepare, ({ body, respond }) => {
        if (body.filename === "ok.txt") {
          return respond(200, {
            id: "upload-ok",
            filename: body.filename,
            contentType: body.contentType,
            size: body.size,
            uploadUrl: okUploadUrl,
            url: "https://example.com/ok.txt",
          });
        }

        return respond(200, {
          id: "upload-failed",
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
          uploadUrl: failedUploadUrl,
          url: "https://example.com/failed.txt",
        });
      }),
      http.put(okUploadUrl, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.put(failedUploadUrl, () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );
    mockChatLifecycle();
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedAttachFiles = body.attachFiles;
        return respond(201, {
          runId: "run-new-2",
          threadId: "thread-test-2",
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
    await user.upload(fileInput!, [
      new File(["ok"], "ok.txt", { type: "text/plain" }),
      new File(["failed"], "failed.txt", { type: "text/plain" }),
    ]);

    await waitFor(() => {
      expect(screen.getByLabelText("Remove ok.txt")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove failed.txt")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Please review");

    await waitFor(() => {
      expect(capturedAttachFiles).toStrictEqual([
        {
          id: "upload-ok",
          filename: "ok.txt",
          contentType: "text/plain",
          size: 2,
        },
      ]);
    });
  });
});
