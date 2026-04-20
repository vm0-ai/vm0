import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { chatMessagesContract } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();

function mockChatAPI() {
  server.use();
}

// ---------------------------------------------------------------------------
// CHAT-D-056: File type icons render based on getFileTypeIcon(filename)
// ---------------------------------------------------------------------------

describe("chat-d-056: file type icon renders based on getFileTypeIcon", () => {
  it("renders img icon for pdf attachment in chat message", async () => {
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
        document.querySelector('a[download="document.pdf"]'),
      ).toBeInTheDocument();
      expect(
        document.querySelector(
          'a[download="document.pdf"] img[aria-hidden="true"]',
        ),
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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return new Promise<never>(() => {});
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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 2048,
          url: imageUrl,
        });
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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 2048,
          url: imageUrl,
        });
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

    const chipDiv = document.querySelector<HTMLElement>('[title="photo.png"]');
    const chipButton = chipDiv?.querySelector("button");
    await user.click(chipButton!);

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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 2048,
          url: imageUrl,
        });
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

    const chipDiv = document.querySelector<HTMLElement>('[title="photo.png"]');
    const chipButton = chipDiv?.querySelector("button");
    await user.click(chipButton!);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Close"));

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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 2048,
          url: imageUrl,
        });
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

    const chipDiv = document.querySelector<HTMLElement>('[title="photo.png"]');
    const chipButton = chipDiv?.querySelector("button");
    await user.click(chipButton!);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Click the dialog backdrop (the dialog element itself, not a child)
    const dialog = screen.getByRole("dialog");
    await user.click(dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-I-062: Remove button on attachment chips calls onRemove
// ---------------------------------------------------------------------------

describe("chat-i-062: remove button on attachment chip calls onRemove", () => {
  it("removes attachment chip when clicking the Remove button", async () => {
    const user = userEvent.setup();

    server.use(
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 512,
          url: "https://example.com/report.pdf",
        });
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

    await user.click(screen.getByLabelText("Remove report.pdf"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Remove report.pdf"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// CHAT-D-063: Download link renders for file attachments in FileAttachmentChip
// ---------------------------------------------------------------------------

describe("chat-d-063: download link renders for file attachment", () => {
  it("renders a download anchor for file attachments in sent messages", async () => {
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
      const link = document.querySelector<HTMLAnchorElement>(
        `a[download="${filename}"]`,
      );
      expect(link).toBeInTheDocument();
      expect(link?.getAttribute("href")).toBe(fileUrl);
    });
  });

  it("renders a download anchor from the structured attachFiles field", async () => {
    const fileUrl = "https://example.com/spec.pdf";
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
      const link = document.querySelector<HTMLAnchorElement>(
        `a[download="${filename}"]`,
      );
      expect(link).toBeInTheDocument();
      expect(link?.getAttribute("href")).toBe(fileUrl);
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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-video-1",
          filename: "demo.mp4",
          contentType: "video/mp4",
          size: 2048,
          url: videoUrl,
        });
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
      // mockApi cannot be used here: /api/zero/uploads accepts multipart FormData,
      // which is out of scope for the mockApi helper (Phase 0 of #9707).
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          id: "upload-new-1",
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 321,
          url: fileUrl,
        });
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
