/**
 * Tests for zero-attachment-preview.tsx
 *
 * Tests the AttachmentPreview component and its helpers for rendering
 * chat attachment previews (text, json, markdown, csv, pdf, html).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  classifyChatAttachment,
  AttachmentPreview,
} from "../zero-attachment-preview.tsx";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// classifyChatAttachment unit tests
// =============================================================================

describe("classifyChatAttachment", () => {
  it("should classify image content type as image", () => {
    const result = classifyChatAttachment({
      filename: "photo.jpg",
      url: "https://example.com/photo.jpg",
      contentType: "image/jpeg",
    });
    expect(result).toBe("image");
  });

  it("should classify image extension as image", () => {
    const result = classifyChatAttachment({
      filename: "photo.png",
      url: "https://example.com/photo.png",
    });
    expect(result).toBe("image");
  });

  it("should classify video content type as video", () => {
    const result = classifyChatAttachment({
      filename: "video.mp4",
      url: "https://example.com/video.mp4",
      contentType: "video/mp4",
    });
    expect(result).toBe("video");
  });

  it("should classify video extension as video", () => {
    const result = classifyChatAttachment({
      filename: "video.webm",
      url: "https://example.com/video.webm",
    });
    expect(result).toBe("video");
  });

  it("should classify markdown files", () => {
    const mdResult = classifyChatAttachment({
      filename: "readme.md",
      url: "https://example.com/readme.md",
    });
    expect(mdResult).toBe("markdown");

    const markdownContentType = classifyChatAttachment({
      filename: "readme",
      url: "https://example.com/readme",
      contentType: "text/markdown",
    });
    expect(markdownContentType).toBe("markdown");
  });

  it("should classify plain text files", () => {
    const result = classifyChatAttachment({
      filename: "notes.txt",
      url: "https://example.com/notes.txt",
    });
    expect(result).toBe("text");
  });

  it("should classify JSON files", () => {
    const result = classifyChatAttachment({
      filename: "data.json",
      url: "https://example.com/data.json",
    });
    expect(result).toBe("json");

    const jsonContentType = classifyChatAttachment({
      filename: "data",
      url: "https://example.com/data",
      contentType: "application/json",
    });
    expect(jsonContentType).toBe("json");
  });

  it("should classify CSV files", () => {
    const result = classifyChatAttachment({
      filename: "export.csv",
      url: "https://example.com/export.csv",
    });
    expect(result).toBe("csv");

    const csvContentType = classifyChatAttachment({
      filename: "export",
      url: "https://example.com/export",
      contentType: "text/csv",
    });
    expect(csvContentType).toBe("csv");
  });

  it("should classify PDF files", () => {
    const result = classifyChatAttachment({
      filename: "document.pdf",
      url: "https://example.com/document.pdf",
    });
    expect(result).toBe("pdf");

    const pdfContentType = classifyChatAttachment({
      filename: "document",
      url: "https://example.com/document",
      contentType: "application/pdf",
    });
    expect(pdfContentType).toBe("pdf");
  });

  it("should classify HTML files by extension and content type", () => {
    const htmlResult = classifyChatAttachment({
      filename: "page.html",
      url: "https://example.com/page.html",
    });
    expect(htmlResult).toBe("html");

    const htmResult = classifyChatAttachment({
      filename: "page.htm",
      url: "https://example.com/page.htm",
    });
    expect(htmResult).toBe("html");

    const htmlContentType = classifyChatAttachment({
      filename: "page",
      url: "https://example.com/page",
      contentType: "text/html",
    });
    expect(htmlContentType).toBe("html");
  });

  it("should fall back to 'file' for unknown types", () => {
    const result = classifyChatAttachment({
      filename: "archive.zip",
      url: "https://example.com/archive.zip",
    });
    expect(result).toBe("file");
  });

  it("should handle filenames without extensions", () => {
    const result = classifyChatAttachment({
      filename: "noextension",
      url: "https://example.com/noextension",
    });
    expect(result).toBe("file");
  });

  it("should handle svg as image", () => {
    const result = classifyChatAttachment({
      filename: "icon.svg",
      url: "https://example.com/icon.svg",
    });
    expect(result).toBe("image");
  });

  it("should handle content type with charset suffix", () => {
    const result = classifyChatAttachment({
      filename: "data.json",
      url: "https://example.com/data.json",
      contentType: "application/json; charset=utf-8",
    });
    expect(result).toBe("json");
  });
});

// =============================================================================
// AttachmentPreview component tests
// =============================================================================

describe("attachment preview component", () => {
  function renderPreview(attachment: {
    filename: string;
    url: string;
    contentType?: string;
  }) {
    const result = render(
      <StoreProvider value={context.store}>
        <AttachmentPreview attachment={attachment} signal={context.signal} />
      </StoreProvider>,
    );
    return result;
  }

  it("should render null for unrecognized file type (file kind)", () => {
    const { container } = renderPreview({
      filename: "archive.zip",
      url: "https://example.com/archive.zip",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("should render text preview for .txt files", async () => {
    server.use(
      http.get("https://example.com/notes.txt", () => {
        return HttpResponse.text("Hello world");
      }),
    );

    renderPreview({
      filename: "notes.txt",
      url: "https://example.com/notes.txt",
    });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });
  });

  it("should render json preview for .json files", async () => {
    server.use(
      http.get("https://example.com/data.json", () => {
        return HttpResponse.json({ key: "value" });
      }),
    );

    renderPreview({
      filename: "data.json",
      url: "https://example.com/data.json",
    });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
    });
  });

  it("should render document thumbnail preview for markdown files", () => {
    renderPreview({
      filename: "readme.md",
      url: "https://example.com/readme.md",
    });

    expect(
      screen.getByTestId("attachment-preview-markdown"),
    ).toBeInTheDocument();
  });

  it("should render document thumbnail preview for CSV files", () => {
    renderPreview({
      filename: "export.csv",
      url: "https://example.com/export.csv",
    });

    expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
  });

  it("should render document thumbnail preview for PDF files", () => {
    renderPreview({
      filename: "document.pdf",
      url: "https://example.com/document.pdf",
    });

    expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
  });

  it("should render document thumbnail preview for HTML files", () => {
    renderPreview({
      filename: "page.html",
      url: "https://example.com/page.html",
    });

    expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
  });
});

// =============================================================================
// TextPreview class component tests
// =============================================================================

describe("text preview loading and error states", () => {
  it("should show loading spinner initially", async () => {
    const gate = createDeferredPromise<void>(context.signal);
    server.use(
      http.get("https://example.com/notes.txt", async () => {
        await gate.promise;
        return HttpResponse.text("Loaded");
      }),
    );

    const { container } = render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "notes.txt",
            url: "https://example.com/notes.txt",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    // The text preview renders immediately with loading state
    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });
    // Loading spinner should be present
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();

    gate.resolve();

    await waitFor(() => {
      expect(screen.getByText("Loaded")).toBeInTheDocument();
    });
  });

  it("should show error state when fetch fails", async () => {
    server.use(
      http.get("https://example.com/error.txt", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "error.txt",
            url: "https://example.com/error.txt",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Preview unavailable.")).toBeInTheDocument();
    });
  });

  it("should show loaded text content", async () => {
    server.use(
      http.get("https://example.com/hello.txt", () => {
        return HttpResponse.text("Hello world");
      }),
    );

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "hello.txt",
            url: "https://example.com/hello.txt",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  it("should collapse text preview when collapsed", async () => {
    server.use(
      http.get("https://example.com/long.txt", () => {
        return HttpResponse.text("Long content here");
      }),
    );

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "long.txt",
            url: "https://example.com/long.txt",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Long content here")).toBeInTheDocument();
    });

    // Click to collapse
    const button = screen.getAllByRole("button").find((el) => {
      return /collapse/i.test(el.getAttribute("aria-label") ?? "");
    })!;
    fireEvent.click(button);

    // Content should be hidden
    await waitFor(() => {
      expect(screen.queryByText("Long content here")).not.toBeInTheDocument();
    });
  });

  it("should format JSON preview with indentation", async () => {
    server.use(
      http.get("https://example.com/data.json", () => {
        return HttpResponse.json({ name: "test", value: 42 });
      }),
    );

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "data.json",
            url: "https://example.com/data.json",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/"name": "test"/)).toBeInTheDocument();
    });
  });
});

// =============================================================================
// DocumentThumbnailPreview tests
// =============================================================================

describe("document thumbnail preview", () => {
  it("should render markdown document preview", () => {
    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "readme.md",
            url: "https://example.com/readme.md",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    const preview = screen.getByTestId("attachment-preview-markdown");
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveAttribute(
      "aria-label",
      expect.stringContaining("markdown"),
    );
  });

  it("should render CSV document preview", () => {
    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "export.csv",
            url: "https://example.com/export.csv",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    const preview = screen.getByTestId("attachment-preview-csv");
    expect(preview).toBeInTheDocument();
  });

  it("should render PDF document preview", () => {
    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "doc.pdf",
            url: "https://example.com/doc.pdf",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    const preview = screen.getByTestId("attachment-preview-pdf");
    expect(preview).toBeInTheDocument();
  });

  it("should render HTML document preview", () => {
    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "page.html",
            url: "https://example.com/page.html",
          }}
          signal={context.signal}
        />
      </StoreProvider>,
    );

    const preview = screen.getByTestId("attachment-preview-html");
    expect(preview).toBeInTheDocument();
  });
});
