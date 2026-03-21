import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, act, render } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import {
  AttachmentChips,
  FileAttachmentChip,
  ImageLightbox,
} from "../zero-attachment-chips.tsx";
import type { ZeroChatAttachment } from "../../../signals/zero-page/zero-chat.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function renderWithStore(element: React.ReactElement) {
  return render(
    createElement(StoreProvider, { value: context.store }, element),
  );
}

function makeAttachment(
  overrides: Partial<ZeroChatAttachment> & { id: string },
): ZeroChatAttachment {
  return {
    filename: "photo.png",
    contentType: "image/png",
    size: 1024,
    url: "https://example.com/photo.png",
    uploading: false,
    ...overrides,
  };
}

describe("attachment chips", () => {
  it("should render image attachment with thumbnail", () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "img-1",
            filename: "screenshot.png",
            contentType: "image/png",
            url: "https://example.com/screenshot.png",
          }),
        ],
        onRemove,
      }),
    );

    const chip = screen.getByTitle("screenshot.png");
    const img = chip.querySelector("img");
    expect(img).toHaveAttribute("src", "https://example.com/screenshot.png");
  });

  it("should render file attachment with file icon for known type", () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "file-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            url: "https://example.com/report.pdf",
          }),
        ],
        onRemove,
      }),
    );

    expect(screen.getByTitle("report.pdf")).toBeInTheDocument();
  });

  it("should call onRemove when remove button is clicked", async () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "file-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            url: "https://example.com/report.pdf",
          }),
        ],
        onRemove,
      }),
    );

    const removeButton = screen.getByLabelText("Remove report.pdf");
    await act(() => {
      fireEvent.click(removeButton);
    });

    expect(onRemove).toHaveBeenCalledWith("file-1");
  });

  it("should show uploading spinner instead of remove button", () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "uploading-1",
            filename: "photo.png",
            contentType: "image/png",
            url: "",
            uploading: true,
          }),
        ],
        onRemove,
      }),
    );

    expect(screen.queryByLabelText("Remove photo.png")).not.toBeInTheDocument();
  });

  it("should open lightbox when clicking image attachment", async () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "img-1",
            contentType: "image/png",
            url: "https://example.com/photo.png",
          }),
        ],
        onRemove,
      }),
    );

    const imageButton = screen.getByRole("button", { name: "" });
    await act(() => {
      fireEvent.click(imageButton);
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should close lightbox when Escape key is pressed", async () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "img-1",
            contentType: "image/png",
            url: "https://example.com/photo.png",
          }),
        ],
        onRemove,
      }),
    );

    // Open the lightbox
    const imageButton = screen.getByRole("button", { name: "" });
    await act(() => {
      fireEvent.click(imageButton);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Press Escape to close
    await act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("should close lightbox when clicking the backdrop", async () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "img-1",
            contentType: "image/png",
            url: "https://example.com/photo.png",
          }),
        ],
        onRemove,
      }),
    );

    // Open the lightbox
    const imageButton = screen.getByRole("button", { name: "" });
    await act(() => {
      fireEvent.click(imageButton);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Click the backdrop to close
    const backdrop = screen.getByRole("dialog");
    await act(() => {
      fireEvent.click(backdrop);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("should close lightbox when clicking the close button", async () => {
    const onRemove = vi.fn();
    renderWithStore(
      createElement(AttachmentChips, {
        attachments: [
          makeAttachment({
            id: "img-1",
            contentType: "image/png",
            url: "https://example.com/photo.png",
          }),
        ],
        onRemove,
      }),
    );

    // Open the lightbox
    const imageButton = screen.getByRole("button", { name: "" });
    await act(() => {
      fireEvent.click(imageButton);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Click the close button
    const closeButton = screen.getByLabelText("Close");
    await act(() => {
      fireEvent.click(closeButton);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("image lightbox", () => {
  it("should render with the image url", () => {
    const onClose = vi.fn();
    renderWithStore(
      createElement(ImageLightbox, {
        url: "https://example.com/full.png",
        onClose,
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const images = dialog.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "https://example.com/full.png");
  });

  it("should call onClose when clicking the backdrop", async () => {
    const onClose = vi.fn();
    renderWithStore(
      createElement(ImageLightbox, {
        url: "https://example.com/full.png",
        onClose,
      }),
    );

    const backdrop = screen.getByRole("dialog");
    await act(() => {
      fireEvent.click(backdrop);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should call onClose when clicking the close button", async () => {
    const onClose = vi.fn();
    renderWithStore(
      createElement(ImageLightbox, {
        url: "https://example.com/full.png",
        onClose,
      }),
    );

    const closeButton = screen.getByLabelText("Close");
    await act(() => {
      fireEvent.click(closeButton);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("file attachment chip", () => {
  it("should render download link for PDF file", () => {
    renderWithStore(
      createElement(FileAttachmentChip, {
        filename: "document.pdf",
        url: "https://example.com/document.pdf",
      }),
    );

    const link = screen.getByTitle("document.pdf");
    expect(link).toHaveAttribute("href", "https://example.com/document.pdf");
    expect(link).toHaveAttribute("download", "document.pdf");
  });

  it("should render generic file icon for unknown extension", () => {
    renderWithStore(
      createElement(FileAttachmentChip, {
        filename: "data.xyz",
        url: "https://example.com/data.xyz",
      }),
    );

    const link = screen.getByTitle("data.xyz");
    expect(link).toBeInTheDocument();
  });
});
