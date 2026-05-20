/**
 * Tests for zero-attachment-preview.tsx
 *
 * Integration tests for AttachmentPreview component driven through
 * MSW + DOM assertions. classifyChatAttachment branches are exercised
 * via render rather than direct calls.
 */

import { describe, expect, it } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { computed } from "ccstate";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { fetchPreviewText } from "../../../signals/chat-page/parse-body-blocks.ts";
import { AttachmentPreview } from "../zero-attachment-preview.tsx";

const context = testContext();

// =============================================================================
// AttachmentPreview component — render matrix
// =============================================================================

describe("attachment preview component", () => {
  function renderPreview(attachment: {
    filename: string;
    url: string;
    contentType?: string;
  }) {
    return render(
      <StoreProvider value={context.store}>
        <AttachmentPreview attachment={attachment} />
      </StoreProvider>,
    );
  }

  // Extension-based classification
  // -------------------------------------------------------------------------

  it("should render markdown thumbnail for .md files", () => {
    renderPreview({
      filename: "readme.md",
      url: "https://example.com/readme.md",
    });
    expect(
      screen.getByTestId("attachment-preview-markdown"),
    ).toBeInTheDocument();
  });

  it("should render text preview for .txt files", () => {
    renderPreview({
      filename: "notes.txt",
      url: "https://example.com/notes.txt",
    });
    expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
  });

  it.each(["config.xml", "settings.yaml", "table.tsv"])(
    "should render text preview for %s files",
    (filename) => {
      renderPreview({
        filename,
        url: `https://example.com/${filename}`,
      });
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    },
  );

  it("should render json preview for .json files", () => {
    renderPreview({
      filename: "data.json",
      url: "https://example.com/data.json",
    });
    expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
  });

  it("should render CSV thumbnail for .csv files", () => {
    renderPreview({
      filename: "export.csv",
      url: "https://example.com/export.csv",
    });
    expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
  });

  it("should render PDF thumbnail for .pdf files", () => {
    renderPreview({
      filename: "document.pdf",
      url: "https://example.com/document.pdf",
    });
    expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
  });

  it("should render HTML thumbnail for .html files", () => {
    renderPreview({
      filename: "page.html",
      url: "https://example.com/page.html",
    });
    expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
  });

  it("should render HTML thumbnail for .htm files", () => {
    renderPreview({
      filename: "page.htm",
      url: "https://example.com/page.htm",
    });
    expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
  });

  it("should render audio preview for .mp3 files", () => {
    renderPreview({
      filename: "clip.mp3",
      url: "https://example.com/clip.mp3",
    });
    const preview = screen.getByTestId("attachment-preview-audio");
    expect(preview).toBeInTheDocument();
    expect(screen.getByLabelText("Audio preview for clip.mp3")).toHaveAttribute(
      "src",
      "https://example.com/clip.mp3",
    );
  });

  it("should render null for image files (.svg)", () => {
    const { container } = renderPreview({
      filename: "icon.svg",
      url: "https://example.com/icon.svg",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("should render null for video files (.mp4)", () => {
    const { container } = renderPreview({
      filename: "video.mp4",
      url: "https://example.com/video.mp4",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("should render a thumbnail preview block for non-inline upload file types", () => {
    renderPreview({
      filename: "budget.xlsx",
      url: "https://example.com/budget.xlsx",
    });
    const preview = screen.getByTestId("attachment-preview-file");
    expect(preview).toBeInTheDocument();
    expect(
      within(preview).getByTestId("attachment-preview-file-icon"),
    ).toBeInTheDocument();
    expect(within(preview).getByText("XLSX")).toBeInTheDocument();
    expect(screen.getByLabelText("Download budget.xlsx")).toHaveAttribute(
      "type",
      "button",
    );
  });

  // Content-type fallback (filename has no extension)
  // -------------------------------------------------------------------------

  it("should classify by content-type text/markdown when filename has no extension", () => {
    renderPreview({
      filename: "readme",
      url: "https://example.com/readme",
      contentType: "text/markdown",
    });
    expect(
      screen.getByTestId("attachment-preview-markdown"),
    ).toBeInTheDocument();
  });

  it("should classify by content-type application/json when filename has no extension", () => {
    renderPreview({
      filename: "data",
      url: "https://example.com/data",
      contentType: "application/json",
    });
    expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
  });

  it("should classify by content-type text/csv when filename has no extension", () => {
    renderPreview({
      filename: "export",
      url: "https://example.com/export",
      contentType: "text/csv",
    });
    expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
  });

  it("should classify by content-type application/pdf when filename has no extension", () => {
    renderPreview({
      filename: "document",
      url: "https://example.com/document",
      contentType: "application/pdf",
    });
    expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
  });

  it("should classify by content-type text/html when filename has no extension", () => {
    renderPreview({
      filename: "page",
      url: "https://example.com/page",
      contentType: "text/html",
    });
    expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
  });

  it.each([
    ["application/xml", "xml-file"],
    ["application/yaml", "yaml-file"],
    ["text/tab-separated-values", "tsv-file"],
  ])(
    "should classify by content-type %s as text preview",
    (contentType, filename) => {
      renderPreview({
        filename,
        url: `https://example.com/${filename}`,
        contentType,
      });
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    },
  );

  it("should classify by content-type audio/mpeg when filename has no extension", () => {
    renderPreview({
      filename: "clip",
      url: "https://example.com/clip",
      contentType: "audio/mpeg",
    });
    expect(screen.getByTestId("attachment-preview-audio")).toBeInTheDocument();
  });

  it("should return null for image content-type when filename has no extension", () => {
    const { container } = renderPreview({
      filename: "photo",
      url: "https://example.com/photo",
      contentType: "image/jpeg",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("should return null for video content-type when filename has no extension", () => {
    const { container } = renderPreview({
      filename: "clip",
      url: "https://example.com/clip",
      contentType: "video/mp4",
    });
    expect(container).toBeEmptyDOMElement();
  });

  // Charset suffix
  // -------------------------------------------------------------------------

  it("should strip charset suffix and resolve to json preview", () => {
    renderPreview({
      filename: "data.json",
      url: "https://example.com/data.json",
      contentType: "application/json; charset=utf-8",
    });
    expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
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

    const text$ = computed(() => {
      return fetchPreviewText("https://example.com/notes.txt");
    });

    const { container } = render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "notes.txt",
            url: "https://example.com/notes.txt",
          }}
          text$={text$}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();

    gate.resolve();

    await waitFor(() => {
      expect(screen.getByText("Loaded")).toBeInTheDocument();
    });
  });

  it("should stay in loading state when fetch fails", async () => {
    server.use(
      http.get("https://example.com/error.txt", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const text$ = computed(() => {
      return fetchPreviewText("https://example.com/error.txt");
    });

    const { container } = render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "error.txt",
            url: "https://example.com/error.txt",
          }}
          text$={text$}
        />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
    });

    // Stays in loading state since the computed never resolves
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("should show loaded text content", async () => {
    server.use(
      http.get("https://example.com/hello.txt", () => {
        return HttpResponse.text("Hello world");
      }),
    );

    const text$ = computed(() => {
      return fetchPreviewText("https://example.com/hello.txt");
    });

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "hello.txt",
            url: "https://example.com/hello.txt",
          }}
          text$={text$}
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

    const text$ = computed(() => {
      return fetchPreviewText("https://example.com/long.txt");
    });

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "long.txt",
            url: "https://example.com/long.txt",
          }}
          text$={text$}
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

    const text$ = computed(() => {
      return fetchPreviewText("https://example.com/data.json");
    });

    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: "data.json",
            url: "https://example.com/data.json",
          }}
          text$={text$}
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
        />
      </StoreProvider>,
    );

    const preview = screen.getByTestId("attachment-preview-html");
    expect(preview).toBeInTheDocument();
  });
});
