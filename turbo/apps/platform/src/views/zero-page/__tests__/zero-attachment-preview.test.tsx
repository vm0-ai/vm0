/**
 * Tests for zero-attachment-preview.tsx
 *
 * Integration tests for AttachmentPreview component driven through
 * MSW + DOM assertions. classifyChatAttachment branches are exercised
 * via render rather than direct calls.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { fetchPreviewText } from "../../../signals/chat-page/parse-body-blocks.ts";
import { reloadFeatureSwitch$ } from "../../../signals/external/feature-switch.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  closeLightbox$,
  lightboxUrl$,
} from "../../../signals/zero-page/zero-attachment-chips.ts";
import { AttachmentPreview } from "../zero-attachment-preview.tsx";

const context = testContext();

beforeEach(async () => {
  mockUser({ id: "test-user-123", fullName: "Test User" }, { token: "test" });
  mockOrganization({
    activeOrg: { id: "org_default", name: "Default Org" },
    memberships: [{ id: "org_default" }],
  });
  context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });
  setMockFeatureSwitches({ [FeatureSwitchKey.ChatArtifactSidebar]: false });
  await context.store.set(reloadFeatureSwitch$, context.signal);
  context.store.set(closeLightbox$);
});

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
    expect(preview).toHaveAttribute("type", "button");
    expect(preview.firstElementChild).toHaveClass("aspect-[4/3]");
    expect(
      within(preview).getByTestId("attachment-preview-audio-icon"),
    ).toBeInTheDocument();

    fireEvent.click(preview);

    expect(context.store.get(lightboxUrl$)).toStrictEqual({
      kind: "audio",
      filename: "clip.mp3",
      url: "https://example.com/clip.mp3",
    });
    context.store.set(closeLightbox$);
  });

  it("should render null for image files (.svg)", () => {
    const { container } = renderPreview({
      filename: "icon.svg",
      url: "https://example.com/icon.svg",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("should render video thumbnail for .mp4 files", () => {
    renderPreview({
      filename: "video.mp4",
      url: "https://example.com/video.mp4",
    });
    const preview = screen.getByTestId("attachment-preview-video");
    const video = preview.querySelector("video");

    expect(preview).toBeInTheDocument();
    expect(preview).toHaveClass("w-[min(100%,400px)]");
    expect(preview.firstElementChild).toHaveClass("aspect-[16/10]");
    expect(
      screen.getByLabelText("Open video preview for video.mp4"),
    ).toHaveAttribute("type", "button");
    expect(video?.getAttribute("src")).toBe("https://example.com/video.mp4");
    expect(video?.hasAttribute("controls")).toBeFalsy();
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

  it("should classify by content-type video/mp4 when filename has no extension", () => {
    renderPreview({
      filename: "clip",
      url: "https://example.com/clip",
      contentType: "video/mp4",
    });
    expect(screen.getByTestId("attachment-preview-video")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open video preview for clip"),
    ).toHaveAttribute("type", "button");
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
    const button = queryAllByRoleFast("button").find((el) => {
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
    expect(preview.tagName).toBe("A");
    expect(preview).toHaveClass("w-[min(100%,400px)]");
    expect(preview).toHaveAttribute("href", "https://example.com/page.html");
    expect(preview).toHaveTextContent("page.html");
    const iframe = within(preview).getByTitle("Site preview for page.html");
    expect(iframe).toHaveAttribute(
      "data-preview-src",
      "https://example.com/page.html",
    );
    expect(iframe).toHaveClass("pointer-events-none");
    expect(iframe).toHaveAttribute("tabindex", "-1");
  });

  it("renders HTML site previews from a desktop-sized viewport", () => {
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
    const viewport = within(preview).getByTestId(
      "attachment-preview-html-viewport",
    );

    expect(viewport).toHaveClass("h-[400%]", "w-[400%]", "scale-[0.25]");
    expect(
      within(viewport).getByTitle("Site preview for page.html"),
    ).toHaveAttribute("scrolling", "no");
  });

  it("uses the hosted site slug as the fallback site preview card title", () => {
    const url = "https://tabby-cat-guide-35a4112d.sites.vm7.io";
    render(
      <StoreProvider value={context.store}>
        <AttachmentPreview
          attachment={{
            filename: url,
            url,
            contentType: "text/html",
          }}
        />
      </StoreProvider>,
    );

    expect(screen.getByText("Tabby Cat Guide")).toBeInTheDocument();
    expect(
      screen.getByTitle("Site preview for Tabby Cat Guide"),
    ).toHaveAttribute("data-preview-src", url);
  });

  it("opens HTML previews in the lightbox on plain left click", () => {
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

    fireEvent.click(screen.getByTestId("attachment-preview-html"));

    expect(context.store.get(lightboxUrl$)).toStrictEqual({
      kind: "html",
      filename: "page.html",
      url: "https://example.com/page.html",
    });
  });

  it("keeps modified HTML preview clicks as native anchor navigation", () => {
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

    context.store.set(closeLightbox$);

    fireEvent.click(screen.getByTestId("attachment-preview-html"), {
      metaKey: true,
    });

    expect(context.store.get(lightboxUrl$)).toBeNull();
  });
});
