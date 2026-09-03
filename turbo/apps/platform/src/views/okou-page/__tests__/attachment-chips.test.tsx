import {
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  type ChatThreadArtifactFile,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  act,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { canonicalUserMessageFileUrl } from "../../../signals/chat-page/user-message-files.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";
import { mockResizeObserver } from "./chat-lifecycle-test-helpers.ts";

const context = testContext();
const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

/** Mirrors the presigned object URL the API signs for a private attachment. */
function presignedFileUrl(fileId: string): string {
  return `https://r2.example.com/artifacts/${fileId}?sig=test`;
}

/** Matches presignedFileUrl so a preview body can be served from that URL. */
const PRESIGNED_FILE_PATTERN = "https://r2.example.com/artifacts/:fileId";

/** Mirrors the public artifacts URL the API reports for the same object. */
function publicFileUrl(fileId: string): string {
  return `https://cdn.vm7.io/artifacts/${fileId}.bin`;
}

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-quarterly-roadmap",
    filename: "quarterly-roadmap.html",
    contentType: "text/html",
    artifactKind: "presentation-html",
    size: 1024,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

function setupHostedSiteArtifactPreview({
  artifactUrl,
  filename,
  html,
  htmlUrl,
  label,
  path = `/chats/${THREAD_ID}`,
  previewImageUrl,
  runId,
}: {
  artifactUrl?: string;
  filename: string;
  html?: string;
  htmlUrl: string;
  label: string;
  path?: string;
  previewImageUrl?: string;
  runId: string;
}): void {
  const artifactMetadataUrl = artifactUrl ?? htmlUrl;
  context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
    expect(new URL(request.url).searchParams.get("url")).toBe(htmlUrl);
    return new Response(
      html ??
        `<!doctype html>
      <html>
        <head><title>${label}</title></head>
        <body>
          <main>
            <h1>Launch faster</h1>
            <p>Ship the first version today.</p>
          </main>
        </body>
      </html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [
        {
          runId,
          files: [
            artifactFile(artifactMetadataUrl, {
              artifactKind: "hosted-site",
              filename,
              aliasUrl: htmlUrl,
              ...(previewImageUrl ? { previewImageUrl } : {}),
            }),
          ],
        },
      ],
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: `msg-${runId}`,
        role: "assistant",
        content: `[${label}](${htmlUrl})`,
        runId,
        createdAt: "2026-03-10T00:00:00Z",
      },
    ],
  });

  detachedSetupPage({
    context,
    path,
  });
}

beforeEach(() => {
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    updatedAt: "2026-03-10T00:00:00Z",
  });
  context.mocks.browser.blobDownload();
  context.mocks.http.get("/api/web/download-file", () => {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.http.get("/api/web/file-url", ({ request }) => {
    const fileId = new URL(request.url).searchParams.get("file_id") ?? "";
    return HttpResponse.json({
      url: presignedFileUrl(fileId),
      publicUrl: publicFileUrl(fileId),
    });
  });
});

async function uploadFile(file: File): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(fileInput, file);
}

async function setupComposer(): Promise<void> {
  detachedSetupPage({ context, path: "/" });

  await waitFor(() => {
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
}

async function setupUploadedImagePreview(): Promise<void> {
  context.mocks.upload.success({
    id: "upload-photo",
    filename: "photo.png",
    contentType: "image/png",
    size: 2048,
    url: "https://example.com/photo.png",
  });

  await setupComposer();
  await uploadFile(new File(["img"], "photo.png", { type: "image/png" }));

  await waitFor(() => {
    expect(
      screen.getByLabelText("Open image preview for photo.png"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
  });
}

function mockElementBox(
  element: HTMLElement,
  { height, width }: { height: number; width: number },
) {
  Object.defineProperties(element, {
    clientHeight: {
      configurable: true,
      value: height,
    },
    clientWidth: {
      configurable: true,
      value: width,
    },
    offsetHeight: {
      configurable: true,
      value: height,
    },
    offsetWidth: {
      configurable: true,
      value: width,
    },
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return {
        bottom: height,
        height,
        left: 0,
        right: width,
        toJSON: () => {
          return {};
        },
        top: 0,
        width,
        x: 0,
        y: 0,
      };
    },
  });
}

function touchPoint({
  clientX,
  clientY,
  identifier,
  target,
}: {
  clientX: number;
  clientY: number;
  identifier: number;
  target: EventTarget;
}): Touch {
  return {
    clientX,
    clientY,
    force: 1,
    identifier,
    pageX: clientX,
    pageY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    screenX: clientX,
    screenY: clientY,
    target,
  } as Touch;
}

function zoomWheelEvent(
  target: Element,
  {
    clientX,
    clientY,
    ctrlKey = false,
    deltaY,
    metaKey = false,
  }: {
    clientX: number;
    clientY: number;
    ctrlKey?: boolean;
    deltaY: number;
    metaKey?: boolean;
  },
): Event {
  const event = createEvent.wheel(target);
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    ctrlKey: { value: ctrlKey },
    deltaY: { value: deltaY },
    metaKey: { value: metaKey },
    x: { value: clientX },
    y: { value: clientY },
  });
  return event;
}

function transformedScale(element: HTMLElement): number {
  const match = element.style.transform.match(/scale\(([^)]+)\)/);
  return Number(match?.[1]);
}

function clipboardFileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => {
      return file;
    },
  } as DataTransferItem;
}

const BODY_LINK_PREVIEWS = {
  audio: "https://cdn.vm7.io/artifacts/test/body-audio/briefing.mp3",
  video: "https://cdn.vm7.io/artifacts/test/body-video/demo.mp4",
  image: "https://cdn.vm7.io/artifacts/test/body-image/chart.png",
  markdown: "https://cdn.vm7.io/artifacts/test/body-markdown/release-notes.md",
  csv: "https://cdn.vm7.io/artifacts/test/body-csv/launch-metrics.csv",
  pdf: "https://cdn.vm7.io/artifacts/test/body-pdf/rollout-plan.pdf",
  html: "https://cdn.vm7.io/artifacts/test/body-html/launch-site.html",
  archive: "https://cdn.vm7.io/artifacts/test/body-file/archive.bin",
} as const;

// Renders one assistant message carrying every supported preview link type and
// waits until each parsed chip is on screen. The media and document preview
// specs share this setup so that each spec opens only its own previews within
// the default test timeout.
async function setupBodyLinkPreviews(): Promise<void> {
  const { audio, video, image, markdown, csv, pdf, html, archive } =
    BODY_LINK_PREVIEWS;
  context.mocks.http.get(markdown, () => {
    return new Response(
      "# Release notes\n\nBody link rollout is ready.\n\n" +
        "```mermaid\nflowchart TD\n  A --> B\n```",
      {
        headers: { "Content-Type": "text/markdown" },
      },
    );
  });
  context.mocks.http.get(csv, () => {
    return new Response("metric,value\nactivation,87", {
      headers: { "Content-Type": "text/csv" },
    });
  });
  context.mocks.http.get(archive, () => {
    return new Response(null, { status: 500 });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "msg-body-preview-links",
        role: "assistant",
        content: `Generated preview links:\n\n${audio}\n${video}\n${image}\n${markdown}\n${csv}\n${pdf}\n[Launch site](${html})\n${archive}`,
        runId: "run-body-previews",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ],
  });

  detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

  await waitFor(() => {
    expect(screen.getByText("Generated preview links:")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open audio preview for briefing.mp3"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
    expect(screen.getByAltText("chart.png")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open markdown preview for release-notes.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open csv preview for launch-metrics.csv"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open pdf preview for rollout-plan.pdf"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open html preview for Launch site"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Preview archive.bin")).toBeInTheDocument();
  });
}

describe("zero attachment chips", () => {
  it("shows pending upload progress for composer attachments", async () => {
    context.mocks.upload.pending({
      id: "upload-pending",
      filename: "document.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/document.pdf",
    });

    await setupComposer();
    await uploadFile(
      new File(["data"], "document.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload document.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("uploads a pasted file and keeps pasted text in the composer", async () => {
    context.mocks.upload.success({
      id: "upload-pasted-notes",
      filename: "pasted-notes.txt",
      contentType: "text/plain",
      size: 18,
      url: "https://example.com/pasted-notes.txt",
    });

    await setupComposer();

    const composer = await waitFor(() => {
      const editor = document.querySelector(
        '.zero-composer [contenteditable="true"]',
      );
      if (!(editor instanceof HTMLElement)) {
        throw new Error("Composer editor not found");
      }
      return editor;
    });
    const file = new File(["pasted file body"], "pasted-notes.txt", {
      type: "text/plain",
    });

    fireEvent.paste(composer, {
      clipboardData: {
        items: [clipboardFileItem(file)],
        getData: (type: string) => {
          return type === "text/plain" ? "Pasted context" : "";
        },
      },
    });

    await waitFor(() => {
      expect(composer).toHaveTextContent("Pasted context");
      expect(
        screen.getByLabelText("Remove pasted-notes.txt"),
      ).toBeInTheDocument();
    });
  });

  it("uploads a file dropped onto the composer", async () => {
    context.mocks.upload.success({
      id: "upload-dropped-report",
      filename: "dropped-report.pdf",
      contentType: "application/pdf",
      size: 128,
      url: "https://example.com/dropped-report.pdf",
    });

    await setupComposer();

    const composerCard = screen
      .getByPlaceholderText(PLACEHOLDER)
      .closest(".zero-composer");
    if (!(composerCard instanceof HTMLElement)) {
      throw new Error("Composer card not found");
    }

    fireEvent.dragOver(composerCard, {
      dataTransfer: {
        files: [
          new File(["dropped report"], "dropped-report.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    fireEvent.drop(composerCard, {
      dataTransfer: {
        files: [
          new File(["dropped report"], "dropped-report.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Remove dropped-report.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("shows completed image previews and removable composer chips", async () => {
    const imageUrl = "https://example.com/photo.png";

    await setupUploadedImagePreview();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open image preview for photo.png"),
      ).toBeInTheDocument();
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    const image = document.querySelector<HTMLImageElement>(
      `img[src="${imageUrl}"]`,
    );
    if (!image) {
      throw new Error("Composer image preview not found");
    }

    fireEvent.load(image);
    await waitFor(() => {
      expect(
        screen.queryByTestId("composer-image-preview-loading"),
      ).not.toBeInTheDocument();
    });

    fireEvent.error(image);
    await waitFor(() => {
      expect(
        screen.getByTestId("composer-image-preview-loading"),
      ).toBeInTheDocument();
    });
  });

  it("prevents viewport pinch outside the image preview canvas", async () => {
    await setupUploadedImagePreview();

    const composer = screen.getByPlaceholderText(PLACEHOLDER);
    const wheelPinchEvent = zoomWheelEvent(composer, {
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
      deltaY: -20,
    });
    fireEvent(composer, wheelPinchEvent);
    expect(wheelPinchEvent.defaultPrevented).toBeTruthy();

    const scrollEvent = createEvent.wheel(composer, { deltaY: 20 });
    fireEvent(composer, scrollEvent);
    expect(scrollEvent.defaultPrevented).toBeFalsy();

    for (const eventName of ["gesturestart", "gesturechange"]) {
      const safariPinchEvent = new Event(eventName, {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(composer, safariPinchEvent);
      expect(safariPinchEvent.defaultPrevented).toBeTruthy();
    }

    click(screen.getByLabelText("Open image preview for photo.png"));
    const zoomStage = await screen.findByTestId("artifact-dialog-image-stage");
    const previewPinchEvent = new Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(zoomStage, previewPinchEvent);
    expect(previewPinchEvent.defaultPrevented).toBeFalsy();
  });

  it("zooms an uploaded image preview and resets its canvas when reopened", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    expect(zoomStage).toHaveStyle({ touchAction: "none" });
    expect(zoomStage).toHaveAttribute("data-zoomable-image-canvas", "true");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const transformWrapper = transformContent.parentElement as HTMLElement;

    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformWrapper, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    fireEvent.doubleClick(lightboxImage, { clientX: 200, clientY: 150 });
    await waitFor(() => {
      expect(screen.getByText("200%")).toBeInTheDocument();
      expect(transformContent.style.transform).toBe(
        "translate(-200px, -150px) scale(2)",
      );
    });

    click(screen.getByLabelText("Reset zoom"));
    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(transformContent.style.transform).toBe(
        "translate(0px, 0px) scale(1)",
      );
    });

    click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
      expect(lightboxImage).toHaveStyle({ width: "800px" });
      expect(transformContent.style.transform).toContain("scale(1.15)");
    });

    const zoomInButton = screen.getByLabelText("Zoom in");
    for (let i = 0; i < 13; i += 1) {
      click(zoomInButton);
    }

    await waitFor(() => {
      expect(screen.getByText("300%")).toBeInTheDocument();
      expect(lightboxImage).toHaveStyle({ width: "800px" });
      expect(transformContent.style.transform).toContain("scale(3)");
      expect(zoomInButton).toBeDisabled();
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveStyle({
      width: "100%",
    });
  });

  it("resets a transformed uploaded image preview with double-click", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");

    mockElementBox(zoomStage, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
      expect(transformContent.style.transform).toContain("scale(1.15)");
    });

    fireEvent.doubleClick(lightboxImage, { clientX: 200, clientY: 150 });
    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(transformContent.style.transform).toBe(
        "translate(0px, 0px) scale(1)",
      );
    });
  });

  it("closes the attachment lightbox with Escape before browser shortcuts run", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes the attachment lightbox with a deliberate backdrop click", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    fireEvent.click(await screen.findByTestId("attachment-lightbox-backdrop"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the attachment lightbox open when a drag ends on the backdrop", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    // Panning a zoomed image past the panel edge releases the button over the
    // backdrop, so the browser dispatches the click at the common ancestor of
    // the two endpoints — the popup, not the backdrop.
    fireEvent.click(await screen.findByTestId("attachment-lightbox"));

    await waitFor(() => {
      expect(
        screen.getByTestId("attachment-lightbox-panel"),
      ).toBeInTheDocument();
    });

    // The backdrop still dismisses once a press really both starts and ends on it.
    fireEvent.click(screen.getByTestId("attachment-lightbox-backdrop"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("pans an uploaded image preview with ordinary wheel events", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const transformWrapper = transformContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformWrapper, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 1200, width: 1600 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    click(screen.getByLabelText("Zoom in"));

    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
      expect(transformContent.style.transform).toContain("scale(1.15)");
    });

    const transformBeforePan = transformContent.style.transform;
    const trackpadPanEvent = createEvent.wheel(transformWrapper, {
      deltaX: 12,
      deltaY: 24,
    });
    fireEvent(transformWrapper, trackpadPanEvent);

    expect(trackpadPanEvent.defaultPrevented).toBeTruthy();
    expect(transformContent.style.transform).not.toBe(transformBeforePan);
    expect(transformContent.style.transform).toContain("scale(1.15)");

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("uses proportional trackpad zoom with capped deltas and supports Command", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const transformWrapper = transformContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformWrapper, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    const commandWheelEvent = zoomWheelEvent(transformWrapper, {
      clientX: 400,
      clientY: 300,
      deltaY: -10,
      metaKey: true,
    });
    fireEvent(transformWrapper, commandWheelEvent);

    expect(commandWheelEvent.defaultPrevented).toBeTruthy();
    await waitFor(() => {
      expect(transformedScale(transformContent)).toBeCloseTo(Math.exp(0.3), 5);
    });

    const pinchWheelEvent = zoomWheelEvent(transformWrapper, {
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: -20,
    });
    fireEvent(transformWrapper, pinchWheelEvent);

    expect(pinchWheelEvent.defaultPrevented).toBeTruthy();
    await waitFor(() => {
      expect(transformedScale(transformContent)).toBeCloseTo(Math.exp(0.6), 5);
    });

    const zoomOutWheelEvent = zoomWheelEvent(transformWrapper, {
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: 10,
    });
    fireEvent(transformWrapper, zoomOutWheelEvent);

    expect(zoomOutWheelEvent.defaultPrevented).toBeTruthy();
    await waitFor(() => {
      expect(transformedScale(transformContent)).toBeCloseTo(Math.exp(0.3), 5);
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("zooms a tall image up to three times the viewport width", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const transformWrapper = transformContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformWrapper, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 600, width: 800 });
    Object.defineProperties(lightboxImage, {
      naturalHeight: {
        configurable: true,
        value: 25_263,
      },
      naturalWidth: {
        configurable: true,
        value: 1179,
      },
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "28px" });
    });

    for (let index = 0; index < 15; index += 1) {
      const maxZoomEvent = zoomWheelEvent(transformWrapper, {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -10_000,
      });
      fireEvent(transformWrapper, maxZoomEvent);
      expect(maxZoomEvent.defaultPrevented).toBeTruthy();
    }

    await waitFor(() => {
      expect(transformContent.style.transform).toContain("scale(85.7099)");
      expect(screen.getByLabelText("Zoom in")).toBeDisabled();
    });

    const transformAtMaxZoom = transformContent.style.transform;
    const beyondMaxZoomEvent = zoomWheelEvent(transformWrapper, {
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: -120,
    });
    fireEvent(transformWrapper, beyondMaxZoomEvent);

    expect(beyondMaxZoomEvent.defaultPrevented).toBeTruthy();
    expect(transformContent.style.transform).toBe(transformAtMaxZoom);

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps an uploaded image preview stable when zooming past the maximum from the top-left", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const transformWrapper = transformContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    const zoomInButton = screen.getByLabelText("Zoom in");
    for (let i = 0; i < 14; i += 1) {
      click(zoomInButton);
    }

    await waitFor(() => {
      expect(screen.getByText("300%")).toBeInTheDocument();
      expect(transformContent.style.transform).toContain("scale(3)");
    });

    const transformAtMaxZoom = transformContent.style.transform;
    fireEvent.keyDown(window, { key: "Control" });
    const maxedWheelEvent = createEvent.wheel(transformWrapper, {
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
      deltaY: -120,
    });
    fireEvent(transformWrapper, maxedWheelEvent);
    fireEvent.keyUp(window, { key: "Control" });

    expect(maxedWheelEvent.defaultPrevented).toBeTruthy();
    expect(transformContent.style.transform).toBe(transformAtMaxZoom);

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("pinches an uploaded image preview with touch gestures", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });
    expect(zoomStage).toHaveStyle({ touchAction: "none" });

    const firstTouch = touchPoint({
      clientX: 100,
      clientY: 100,
      identifier: 1,
      target: lightboxImage,
    });
    const secondTouch = touchPoint({
      clientX: 300,
      clientY: 100,
      identifier: 2,
      target: lightboxImage,
    });
    fireEvent.touchStart(lightboxImage, {
      touches: [firstTouch, secondTouch],
    });
    fireEvent.touchMove(lightboxImage, {
      touches: [
        firstTouch,
        touchPoint({
          clientX: 500,
          clientY: 100,
          identifier: 2,
          target: lightboxImage,
        }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("200%")).toBeInTheDocument();
      expect(lightboxImage).toHaveStyle({ width: "800px" });
      expect(transformContent.style.transform).toContain("scale(2)");
    });

    fireEvent.touchEnd(lightboxImage, {
      touches: [],
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps an uploaded image preview stable when pinching past the maximum", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    const zoomStage = screen.getByTestId("artifact-dialog-image-stage");
    const zoomContent = screen.getByTestId(
      "artifact-dialog-image-stage-content",
    );
    const transformContent = zoomContent.parentElement as HTMLElement;
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    mockElementBox(transformContent, { height: 600, width: 800 });
    Object.defineProperty(lightboxImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    fireEvent.load(lightboxImage);

    await waitFor(() => {
      expect(lightboxImage).toHaveStyle({ width: "800px" });
    });

    const firstTouch = touchPoint({
      clientX: 0,
      clientY: 0,
      identifier: 1,
      target: lightboxImage,
    });
    const secondTouch = touchPoint({
      clientX: 200,
      clientY: 0,
      identifier: 2,
      target: lightboxImage,
    });
    fireEvent.touchStart(lightboxImage, {
      touches: [firstTouch, secondTouch],
    });
    fireEvent.touchMove(lightboxImage, {
      touches: [
        firstTouch,
        touchPoint({
          clientX: 600,
          clientY: 0,
          identifier: 2,
          target: lightboxImage,
        }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("300%")).toBeInTheDocument();
      expect(transformContent.style.transform).toContain("scale(3)");
    });

    const transformAtMaxZoom = transformContent.style.transform;
    fireEvent.touchMove(lightboxImage, {
      touches: [
        touchPoint({
          clientX: 4,
          clientY: 2,
          identifier: 1,
          target: lightboxImage,
        }),
        touchPoint({
          clientX: 700,
          clientY: 2,
          identifier: 2,
          target: lightboxImage,
        }),
      ],
    });

    expect(transformContent.style.transform).toBe(transformAtMaxZoom);

    fireEvent.touchEnd(lightboxImage, {
      touches: [],
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("removes an uploaded image preview from the composer", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Remove photo.png"));
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Open image preview for photo.png"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows user image attachments before the text bubble in chat history", async () => {
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toMatch(/^Bearer /);
      expect(new URL(request.url).searchParams.get("file_id")).toBe(
        "attachment-photo",
      );
      return HttpResponse.json({ url: presignedFileUrl("attachment-photo") });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-image-then-text",
          role: "user",
          content: "Review this image",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-photo",
              filenameSnapshot: "photo.png",
              contentType: "image/png",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const image = await screen.findByAltText("photo.png");
    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        presignedFileUrl("attachment-photo"),
      );
    });
    const preview = image.closest("a");
    const text = await screen.findByText("Review this image");
    const textBubble = text.closest(".zero-chat-bubble-user");

    expect(preview).not.toBeNull();
    expect(preview).toHaveAttribute(
      "href",
      presignedFileUrl("attachment-photo"),
    );
    expect(textBubble).not.toBeNull();
    expect(preview?.closest(".zero-chat-bubble-user")).toBeNull();
    expect(
      preview!.compareDocumentPosition(textBubble!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("isolates one canonical attachment url between split-view threads", async () => {
    const leftThreadId = "b0000000-0000-4000-a000-000000000053";
    const rightThreadId = "b0000000-0000-4000-a000-000000000054";
    const fileId = "attachment-owner-scoped-photo";
    const ownerUrls = [
      `https://r2.example.com/artifacts/${fileId}?sig=thread-owner-1`,
      `https://r2.example.com/artifacts/${fileId}?sig=thread-owner-2`,
    ] as const;
    let nextOwnerUrl = 0;
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      expect(new URL(request.url).searchParams.get("file_id")).toBe(fileId);
      const url = ownerUrls[Math.min(nextOwnerUrl, ownerUrls.length - 1)]!;
      nextOwnerUrl += 1;
      return HttpResponse.json({ url });
    });
    const lifecycle = mockChatLifecycle(context, {
      threadId: leftThreadId,
      threadTitle: "Left attachment thread",
    });
    lifecycle.setThreadList([
      {
        id: leftThreadId,
        title: "Left attachment thread",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: rightThreadId,
        title: "Right attachment thread",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        if (
          params.threadId !== leftThreadId &&
          params.threadId !== rightThreadId
        ) {
          return respond(200, chatEventRowsResponse([], query));
        }
        return respond(
          200,
          chatEventRowsResponse(
            mockChatEventRows([
              {
                id: `msg-${params.threadId}`,
                threadId: params.threadId,
                eventType: "input.prompt",
                content: null,
                userMessage: {
                  version: 1,
                  parts: [
                    {
                      type: "file",
                      fileId,
                      filenameSnapshot: "owner-scoped.png",
                      contentType: "image/png",
                    },
                  ],
                },
                runId: `run-${params.threadId}`,
                seqId: 1,
                createdAt: "2026-03-10T00:00:00Z",
              },
            ]).filter((row) => {
              return row.seqId > query.sinceSeqId;
            }),
            query,
          ),
        );
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${leftThreadId}?sidebar=${rightThreadId}`,
    });

    const threadRegions = await waitFor(() => {
      const regions = screen.getAllByLabelText("Chat thread");
      expect(regions).toHaveLength(2);
      return regions;
    });
    const previews = await Promise.all(
      threadRegions.map((region) => {
        return within(region).findByLabelText("Preview owner-scoped.png");
      }),
    );

    await waitFor(() => {
      expect(
        previews
          .map((preview) => {
            return preview.getAttribute("href");
          })
          .sort(),
      ).toStrictEqual([...ownerUrls].sort());
    });
  });

  it("replaces direct attachment preview urls with the page owner", async () => {
    const user = userEvent.setup({ delay: null });
    const fileId = "attachment-page-owned-photo";
    const pageUrls = {
      first: `https://r2.example.com/artifacts/${fileId}?sig=page-owner-1`,
      second: `https://r2.example.com/artifacts/${fileId}?sig=page-owner-2`,
    } as const;
    let pageOwner: keyof typeof pageUrls = "first";
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      expect(new URL(request.url).searchParams.get("file_id")).toBe(fileId);
      return HttpResponse.json({ url: pageUrls[pageOwner] });
    });
    context.mocks.api(logsListContract.list, ({ respond }) => {
      return respond(200, {
        data: [],
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-page-owned-photo",
          role: "user",
          content: "Review this image",
          fileParts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "page-owned.png",
              contentType: "image/png",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const firstPreview = await screen.findByLabelText("Preview page-owned.png");
    await waitFor(() => {
      expect(firstPreview).toHaveAttribute("href", pageUrls.first);
    });
    click(firstPreview);
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        pageUrls.first,
      );
    });
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    const agentsLink = await waitFor(() => {
      const rail = screen.getByTestId("labeled-nav-rail");
      const link = within(rail).getByText("Agents").closest("a");
      if (!link) {
        throw new Error("Expected the Agents navigation link");
      }
      return link;
    });
    await user.click(agentsLink);
    await screen.findByRole("heading", { name: "Agents" });
    pageOwner = "second";

    act(() => {
      window.history.back();
    });

    const secondPreview = await screen.findByLabelText(
      "Preview page-owned.png",
    );
    await waitFor(() => {
      expect(secondPreview).toHaveAttribute("href", pageUrls.second);
    });
    click(secondPreview);
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        pageUrls.second,
      );
    });
  });

  it("resolves the user image preview loading state", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-stable-photo",
          role: "user",
          content: "Review this image",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-stable-photo",
              filenameSnapshot: "photo.png",
              contentType: "image/png",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const image = await screen.findByAltText("photo.png");
    const preview = image.closest("a");
    if (!preview) {
      throw new Error("Chat image preview link not found");
    }
    expect(
      within(preview).getByTestId("chat-image-preview-loading"),
    ).toBeInTheDocument();

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("chat-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
  });

  it("renders a canonical Slack input with the standard attachment UI", async () => {
    const assetId = "a0000000-0000-4000-a000-000000000051";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-canonical-slack-input",
          role: "user",
          content: "Review the source notes",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Review the source notes" },
              {
                type: "file",
                fileId: assetId,
                filenameSnapshot: "source-notes.md",
                contentType: "text/markdown",
              },
              {
                type: "source",
                kind: "slack",
                href: "https://example.slack.com/archives/C123/p123456789",
              },
            ],
          },
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Open markdown preview for source-notes.md"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Open original message in Slack"),
    ).toBeInTheDocument();
    expect(screen.getByText("Review the source notes")).toBeInTheDocument();
  });

  it("resolves a file part from its canonical identity", async () => {
    const assetId = "a0000000-0000-4000-a000-000000000052";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-failed-slack-input",
          role: "user",
          content: "Use this attachment",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Use this attachment" },
              {
                type: "file",
                fileId: assetId,
                filenameSnapshot: "expired.pdf",
                contentType: "application/pdf",
              },
              {
                type: "source",
                kind: "slack",
                href: "https://example.slack.com/archives/C123/p123456790",
              },
            ],
          },
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Open pdf preview for expired.pdf"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Attachment unavailable")).toBeNull();
  });

  it("renders canonical user video attachments at the same size as image attachments", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-image-video-attachments",
          role: "user",
          content: "this is the screencast",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-photo",
              filenameSnapshot: "photo.png",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId: "attachment-screencast",
              filenameSnapshot: "screencast.mp4",
              contentType: "video/mp4",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const imagePreview = await screen.findByLabelText("Preview photo.png");
    const videoPreview = screen.getByLabelText("Preview screencast.mp4");

    const inlineMediaPreviewSizeClasses = [
      "aspect-[10/9]",
      "w-[50px]",
      "max-w-full",
    ];

    expect(imagePreview).toHaveClass(...inlineMediaPreviewSizeClasses);
    expect(videoPreview).toHaveClass(...inlineMediaPreviewSizeClasses);
    expect(videoPreview).toHaveClass("cursor-pointer", "bg-black");
    expect(
      within(videoPreview).getByTestId("chat-video-preview-poster"),
    ).toHaveClass("h-full", "w-full");
    expect(
      within(videoPreview).getByTestId("chat-video-preview-poster"),
    ).toBeEmptyDOMElement();
    expect(videoPreview).not.toHaveClass("w-[min(100%,400px)]");
    expect(screen.getByText("this is the screencast")).toBeInTheDocument();
  });

  it("shows user attachments above the text bubble with media and file chips on separate rows", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-video-then-text",
          role: "user",
          content: "Watch this clip",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-clip",
              filenameSnapshot: "clip.mp4",
              contentType: "video/mp4",
            },
            {
              type: "file",
              fileId: "attachment-readme",
              filenameSnapshot: "README.md",
              contentType: "text/markdown",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const videoPreview = await screen.findByLabelText("Preview clip.mp4");
    const text = await screen.findByText("Watch this clip");
    const textBubble = text.closest(".zero-chat-bubble-user");
    const docChip = screen.getByLabelText(
      "Open markdown preview for README.md",
    );

    expect(textBubble).not.toBeNull();
    expect(videoPreview.closest(".zero-chat-bubble-user")).toBeNull();
    expect(docChip.closest(".zero-chat-bubble-user")).toBeNull();
    expect(
      videoPreview.compareDocumentPosition(textBubble!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      docChip.compareDocumentPosition(textBubble!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("message-media-attachments")).getByLabelText(
        "Preview clip.mp4",
      ),
    ).toBe(videoPreview);
    expect(
      within(screen.getByTestId("message-file-attachments")).getByLabelText(
        "Open markdown preview for README.md",
      ),
    ).toBe(docChip);
  });

  it("opens persisted canonical audio, video, and document attachments", async () => {
    context.mocks.http.get(PRESIGNED_FILE_PATTERN, ({ params }) => {
      expect(params.fileId).toBe("attachment-json");
      return new Response(JSON.stringify({ status: "ready" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-attachments",
          role: "user",
          content: "Review these attachments",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-audio",
              filenameSnapshot: "briefing.mp3",
              contentType: "audio/mpeg",
            },
            {
              type: "file",
              fileId: "attachment-video",
              filenameSnapshot: "demo.mp4",
              contentType: "video/mp4",
            },
            {
              type: "file",
              fileId: "attachment-json",
              filenameSnapshot: "status.json",
              contentType: "application/json",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Review these attachments")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open audio preview for briefing.mp3"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open json preview for status.json"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open audio preview for briefing.mp3"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-audio")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Preview demo.mp4"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Video preview for demo.mp4"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-video"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifact"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open json preview for status.json"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText(/"status": "ready"/u)).toBeInTheDocument();
    });
  });

  it("opens persisted canonical csv, pdf, and html document previews", async () => {
    context.mocks.http.get(PRESIGNED_FILE_PATTERN, ({ params }) => {
      expect(params.fileId).toBe("attachment-csv");
      return new Response("metric,value\nsignups,42\nactivation,87", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-document-previews",
          role: "user",
          content: "Review these document previews",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-csv",
              filenameSnapshot: "launch-metrics.csv",
              contentType: "text/csv",
            },
            {
              type: "file",
              fileId: "attachment-pdf",
              filenameSnapshot: "launch-plan.pdf",
              contentType: "application/pdf",
            },
            {
              type: "file",
              fileId: "attachment-html",
              filenameSnapshot: "launch-site.html",
              contentType: "text/html",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByText("Review these document previews"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for launch-metrics.csv"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for launch-plan.pdf"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for launch-site.html"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open csv preview for launch-metrics.csv"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("metric")).toBeInTheDocument();
      expect(screen.getByText("activation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open pdf preview for launch-plan.pdf"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-document-frame"),
      ).toBeInTheDocument();
    });
    const documentFrame = screen.getByTestId("artifact-dialog-document-frame");
    const iframe = screen.getByTitle("launch-plan.pdf preview");
    expect(screen.getByTestId("artifact-dialog-stage")).toHaveClass(
      "overflow-hidden",
    );
    expect(documentFrame).toHaveClass("h-full", "min-h-0");
    expect(iframe).toHaveAttribute(
      "src",
      `${presignedFileUrl("attachment-pdf")}#navpanes=0`,
    );
    expect(iframe).toHaveClass("h-full", "min-h-0", "border-0");

    // The split view reads the same document, so it must resolve the same
    // loadable URL rather than falling back to the canonical route.
    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("artifact-sidebar-body-pdf")).toHaveAttribute(
        "src",
        `${presignedFileUrl("attachment-pdf")}#navpanes=0`,
      );
    });

    click(screen.getByLabelText("Close artifact"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for launch-site.html"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
        "src",
        presignedFileUrl("attachment-html"),
      );
    });
    expect(
      screen.queryByTestId("presentation-artifact-viewport"),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        presignedFileUrl("attachment-html"),
      );
    });
    expect(
      screen.queryByTestId("presentation-artifact-viewport"),
    ).not.toBeInTheDocument();
  });

  it("navigates modal image artifacts within the current run", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl = canonicalUserMessageFileUrl("artifact-first-image");
    const notesUrl = canonicalUserMessageFileUrl("artifact-notes");
    const secondImageUrl = canonicalUserMessageFileUrl("artifact-second-image");
    // A generated image artifact that lives in the same run but was NOT attached
    // to the message. It must be excluded from message-scoped navigation.
    const generatedArtifactUrl =
      "https://cdn.vm7.io/artifacts/test/image-navigation/generated.png";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-image-navigation",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(notesUrl, {
                id: "artifact-notes",
                filename: "notes.md",
                contentType: "text/markdown",
                size: 64,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-second-image",
                filename: "second.png",
                contentType: "image/png",
                size: 256,
              }),
              artifactFile(generatedArtifactUrl, {
                id: "artifact-generated-image",
                filename: "generated.png",
                contentType: "image/png",
                size: 512,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-image-navigation",
          role: "user",
          content: "Review these images",
          fileParts: [
            {
              type: "file",
              fileId: "artifact-first-image",
              filenameSnapshot: "first.png",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId: "artifact-notes",
              filenameSnapshot: "notes.md",
              contentType: "text/markdown",
            },
            {
              type: "file",
              fileId: "artifact-second-image",
              filenameSnapshot: "second.png",
              contentType: "image/png",
            },
          ],
          runId: "run-image-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Preview first.png"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
    expect(screen.getByLabelText("Next image artifact")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "first.png",
    );

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    expect(
      screen.getByLabelText("Previous image artifact"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Next image artifact")).toBeNull();

    // The lightbox modal is immersive: arrow keys navigate even when focus is
    // on an interactive control.
    const shareButton = screen.getByLabelText("Share");
    shareButton.focus();
    fireEvent.keyDown(shareButton, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
  });

  it("shows assistant message image navigation before artifacts load", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/second.png";
    // A generated image that exists in the run artifacts but is NOT referenced
    // in the message body. It must be excluded from message-scoped navigation.
    const unreferencedImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/unreferenced.png";
    const artifactsRequested = context.mocks.deferred<void>();
    const artifactsReady = context.mocks.deferred<void>();
    context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
      artifactsRequested.resolve();
      await artifactsReady.promise;
      return respond(200, {
        runs: [
          {
            runId: "run-body-image-navigation",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-body-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-body-second-image",
                filename: "second.png",
                contentType: "image/png",
                size: 256,
              }),
              artifactFile(unreferencedImageUrl, {
                id: "artifact-body-unreferenced-image",
                filename: "unreferenced.png",
                contentType: "image/png",
                size: 512,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-body-image-navigation",
          role: "assistant",
          content: `Generated images:\n\n${firstImageUrl}\n${secondImageUrl}`,
          runId: "run-body-image-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const bodyImage = await screen.findByAltText("first.png", undefined, {
      timeout: 10_000,
    });
    const previewButton = bodyImage.closest("button");
    if (!previewButton) {
      throw new Error("Markdown image preview button not found");
    }
    fireEvent.load(bodyImage);
    click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    await artifactsRequested.promise;
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
    await expect(
      screen.findByLabelText("Next image artifact"),
    ).resolves.toBeInTheDocument();
    artifactsReady.resolve();

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    // The unreferenced generated artifact is not part of the message, so the
    // last message image has no next target.
    expect(screen.queryByLabelText("Next image artifact")).toBeNull();

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
  });

  it("scopes assistant image navigation to its split-view thread before artifacts load", async () => {
    const user = userEvent.setup({ delay: null });
    const leftThreadId = "b0000000-0000-4000-a000-000000000051";
    const rightThreadId = "b0000000-0000-4000-a000-000000000052";
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/split-image-navigation/first.png";
    const leftSecondImageUrl =
      "https://cdn.vm7.io/artifacts/test/split-image-navigation/left-second.png";
    const rightSecondImageUrl =
      "https://cdn.vm7.io/artifacts/test/split-image-navigation/right-second.png";
    const rightArtifactsRequested = context.mocks.deferred<void>();
    const artifactsReady = context.mocks.deferred<void>();
    context.mocks.api(
      chatThreadArtifactsContract.list,
      async ({ params, respond }) => {
        if (params.threadId === rightThreadId) {
          rightArtifactsRequested.resolve();
        }
        await artifactsReady.promise;
        return respond(200, { runs: [] });
      },
    );
    const lifecycle = mockChatLifecycle(context, {
      threadId: leftThreadId,
      threadTitle: "Left image thread",
    });
    lifecycle.setThreadList([
      {
        id: leftThreadId,
        title: "Left image thread",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: rightThreadId,
        title: "Right image thread",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        const secondImageUrl =
          params.threadId === leftThreadId
            ? leftSecondImageUrl
            : params.threadId === rightThreadId
              ? rightSecondImageUrl
              : undefined;
        if (!secondImageUrl) {
          return respond(200, chatEventRowsResponse([], query));
        }
        return respond(
          200,
          chatEventRowsResponse(
            mockChatEventRows([
              {
                id: `msg-${params.threadId}`,
                threadId: params.threadId,
                eventType: "output.message",
                content: `Generated images:\n\n${firstImageUrl}\n${secondImageUrl}`,
                runId: `run-${params.threadId}`,
                seqId: 1,
                createdAt: "2026-03-10T00:00:00Z",
              },
            ]).filter((row) => {
              return row.seqId > query.sinceSeqId;
            }),
            query,
          ),
        );
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${leftThreadId}?sidebar=${rightThreadId}`,
    });

    const threadRegions = await waitFor(() => {
      const regions = screen.getAllByLabelText("Chat thread");
      expect(regions).toHaveLength(2);
      return regions;
    });
    const leftThread = threadRegions[0];
    const rightThread = threadRegions[1];
    if (!leftThread || !rightThread) {
      throw new Error("Split chat threads not found");
    }
    await expect(
      within(leftThread).findByAltText("first.png"),
    ).resolves.toBeInTheDocument();
    const rightImage = await within(rightThread).findByAltText("first.png");
    const rightPreviewButton = rightImage.closest("button");
    if (!rightPreviewButton) {
      throw new Error("Right thread image preview button not found");
    }
    fireEvent.load(rightImage);
    click(rightPreviewButton);

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    await rightArtifactsRequested.promise;
    await expect(
      screen.findByLabelText("Next image artifact"),
    ).resolves.toBeInTheDocument();

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "right-second.png",
      );
    });
    artifactsReady.resolve();
  });

  it("navigates markdown images generated in an ordered assistant list", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-ordered-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-ordered-navigation/second.png";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-body-image-ordered-navigation",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-body-ordered-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-body-ordered-second-image",
                filename: "second.png",
                contentType: "image/png",
                size: 256,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-body-image-ordered-navigation",
          role: "assistant",
          content: [
            "Generated images:",
            "",
            `1. ![first.png](${firstImageUrl})`,
            `2. ![second.png](${secondImageUrl})`,
          ].join("\n"),
          runId: "run-body-image-ordered-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const bodyImage = await screen.findByAltText("first.png");
    const previewButton = bodyImage.closest("button");
    if (!previewButton) {
      throw new Error("Markdown image preview button not found");
    }
    fireEvent.load(bodyImage);
    click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    expect(screen.getByLabelText("Next image artifact")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
  });

  it("navigates modal images rendered from markdown image links", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-link-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-link-navigation/second.png";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-body-image-link-navigation",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-body-link-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-body-link-second-image",
                filename: "second.png",
                contentType: "image/png",
                size: 256,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-body-image-link-navigation",
          role: "assistant",
          content: [
            "Generated images:",
            "",
            `[First render](${firstImageUrl})`,
            `[Second render](${secondImageUrl})`,
          ].join("\n"),
          runId: "run-body-image-link-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const bodyImage = await screen.findByAltText("First render");
    const previewButton = bodyImage.closest("button");
    if (!previewButton) {
      throw new Error("Markdown image-link preview button not found");
    }
    fireEvent.load(bodyImage);
    click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    expect(screen.getByLabelText("Next image artifact")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
  });

  it("waits for artifacts before showing user message image navigation", async () => {
    const user = userEvent.setup({ delay: null });
    // The images the user attached are NOT part of the thread's run artifacts;
    // they resolve from the user artifacts bucket. Navigation must still work.
    const artifactsRequested = context.mocks.deferred<void>();
    const artifactsReady = context.mocks.deferred<void>();
    context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
      artifactsRequested.resolve();
      await artifactsReady.promise;
      return respond(200, { runs: [] });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-user-image-navigation",
          role: "user",
          content: "Here are my photos",
          fileParts: [
            {
              type: "file",
              fileId: "user-first-image",
              filenameSnapshot: "first.png",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId: "user-second-image",
              filenameSnapshot: "second.png",
              contentType: "image/png",
            },
          ],
          runId: "run-user-image-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await expect(
      screen.findByLabelText("Preview second.png"),
    ).resolves.toBeInTheDocument();
    click(screen.getByLabelText("Preview first.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    await artifactsRequested.promise;
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
    expect(screen.queryByLabelText("Next image artifact")).toBeNull();

    artifactsReady.resolve();
    await expect(
      screen.findByLabelText("Next image artifact"),
    ).resolves.toBeInTheDocument();

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    expect(
      screen.getByLabelText("Previous image artifact"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Next image artifact")).toBeNull();

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
  });

  it("keeps the modal fullscreen state while navigating images", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl = canonicalUserMessageFileUrl(
      "artifact-fullscreen-first-image",
    );
    const secondImageUrl = canonicalUserMessageFileUrl(
      "artifact-fullscreen-second-image",
    );
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-fullscreen-navigation",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-fullscreen-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-fullscreen-second-image",
                filename: "second.png",
                contentType: "image/png",
                size: 256,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-fullscreen-navigation",
          role: "user",
          content: "Review these images",
          fileParts: [
            {
              type: "file",
              fileId: "artifact-fullscreen-first-image",
              filenameSnapshot: "first.png",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId: "artifact-fullscreen-second-image",
              filenameSnapshot: "second.png",
              contentType: "image/png",
            },
          ],
          runId: "run-fullscreen-navigation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Preview first.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });

    await user.click(screen.getByLabelText("Enter fullscreen"));
    expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-lightbox-panel")).toHaveClass(
      "zero-fixed-viewport-shell",
    );

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    // Navigating between images must not collapse fullscreen.
    expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Enter fullscreen")).toBeNull();
  });

  it("opens presentation HTML preview controls from hosted alias links", async () => {
    const resizeObserver = mockResizeObserver();
    const presentationUrl = "https://quarterly-roadmap.sites.vm7.io";
    const presentationDeploymentUrl =
      "https://dpl-quarterly-roadmap.sites.vm7.io";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-presentation",
            files: [
              artifactFile(presentationDeploymentUrl, {
                aliasUrl: presentationUrl,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-presentation-artifact",
          role: "assistant",
          content: `[Quarterly roadmap](${presentationUrl})`,
          runId: "run-presentation",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for Quarterly roadmap"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Quarterly roadmap"));

    await waitFor(() => {
      expect(screen.getByLabelText("Open in split view")).toBeInTheDocument();
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Edit presentation"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    const dialog = screen.getByTestId("attachment-lightbox");
    const dialogViewport = within(dialog).getByTestId(
      "presentation-artifact-viewport",
    );
    mockElementBox(dialogViewport, { height: 600, width: 960 });
    act(() => {
      resizeObserver.automationAll();
    });
    expect(
      within(dialog).getByTestId("presentation-artifact-canvas"),
    ).toHaveStyle({
      height: "1080px",
      transform: "translate(0px, 30px) scale(0.5)",
      visibility: "visible",
      width: "1920px",
    });

    click(screen.getByLabelText("Enter fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expect(screen.getByTestId("attachment-lightbox-panel")).toHaveClass(
      "zero-fixed-viewport-shell",
    );

    click(screen.getByLabelText("Exit fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    expect(screen.getByTestId("attachment-lightbox-panel")).not.toHaveClass(
      "zero-fixed-viewport-shell",
    );

    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    const sidebar = screen.getByTestId("artifact-sidebar");
    const sidebarViewport = within(sidebar).getByTestId(
      "presentation-artifact-viewport",
    );
    mockElementBox(sidebarViewport, { height: 600, width: 480 });
    act(() => {
      resizeObserver.automationAll();
    });
    expect(
      within(sidebar).getByTestId("presentation-artifact-canvas"),
    ).toHaveStyle({
      height: "1080px",
      transform: "translate(0px, 165px) scale(0.25)",
      visibility: "visible",
      width: "1920px",
    });

    click(screen.getByLabelText("Close artifact"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });

  it("uses a hosted artifact thumbnail before falling back to the live iframe", async () => {
    const htmlUrl = "https://thumbnail-soft-switch.sites.vm7.io";
    const artifactUrl =
      "https://cdn.vm7.io/artifacts/test/thumbnail-soft-switch/site-v2.html";
    const previewImageUrl =
      "https://cdn.vm7.io/artifacts/test/thumbnail-soft-switch/preview.webp";
    setupHostedSiteArtifactPreview({
      artifactUrl,
      filename: "thumbnail-soft-switch-v2.html",
      htmlUrl,
      label: "Thumbnail soft switch",
      previewImageUrl,
      runId: "run-thumbnail-soft-switch",
    });

    const thumbnail = await screen.findByTestId("attachment-preview-thumbnail");
    expect(thumbnail).toHaveAttribute("src", previewImageUrl);
    expect(
      screen.queryByTitle("Site preview for Thumbnail soft switch"),
    ).not.toBeInTheDocument();

    fireEvent.error(thumbnail);

    await waitFor(() => {
      expect(
        screen.getByTitle("Site preview for Thumbnail soft switch"),
      ).toHaveAttribute("src", htmlUrl);
    });
  });

  it("localizes a hosted-site preview and its artifact actions", async () => {
    document.documentElement.lang = "pt-BR";
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.browser.clipboardWriteText();
    setupHostedSiteArtifactPreview({
      filename: "localized-site.html",
      htmlUrl: "https://localized-site.sites.vm7.io",
      label: "Launch site",
      runId: "run-localized-site",
    });

    click(
      await screen.findByLabelText("Abrir visualização de HTML de Launch site"),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Compartilhar")).toBeInTheDocument();
      expect(screen.getByLabelText("Opções de download")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Abrir em visualização dividida"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Entrar em tela cheia")).toBeInTheDocument();
      expect(screen.getByLabelText("Fechar")).toBeInTheDocument();
    });
    expect(screen.getByText("localized-site.html")).toBeInTheDocument();
    expect(
      screen.getByText(/^Site hospedado · 1 kB · Gerado em /u),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Compartilhar"));

    await waitFor(() => {
      expect(screen.getByText("Link copiado")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Entrar em tela cheia"));

    await waitFor(() => {
      expect(screen.getByLabelText("Sair da tela cheia")).toBeInTheDocument();
    });
  });

  it("uses a video artifact thumbnail before falling back to the video frame", async () => {
    const videoUrl =
      "https://cdn.vm7.io/artifacts/test/video-thumbnail-soft-switch/demo.mp4";
    const previewImageUrl =
      "https://cdn.vm7.io/artifacts/test/video-thumbnail-soft-switch/poster.jpg";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-video-thumbnail-soft-switch",
            files: [
              artifactFile(videoUrl, {
                id: "artifact-video-thumbnail-soft-switch",
                filename: "demo.mp4",
                contentType: "video/mp4",
                previewImageUrl,
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-video-thumbnail-soft-switch",
          role: "assistant",
          content: videoUrl,
          runId: "run-video-thumbnail-soft-switch",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const thumbnail = await screen.findByTestId("chat-video-preview-thumbnail");
    expect(thumbnail).toHaveAttribute("src", previewImageUrl);
    expect(
      screen.queryByTestId("chat-video-preview-fallback"),
    ).not.toBeInTheDocument();

    fireEvent.error(thumbnail);

    await waitFor(() => {
      expect(screen.getByTestId("chat-video-preview-fallback")).toHaveAttribute(
        "src",
        `${videoUrl}#t=0.001`,
      );
    });
  });

  it("reopens the artifact already in split view without stacking a dialog", async () => {
    const user = userEvent.setup({ delay: null });
    setupHostedSiteArtifactPreview({
      filename: "split-dialog-download.html",
      htmlUrl: "https://split-dialog-download.sites.vm7.io",
      label: "Split dialog download",
      runId: "run-split-dialog-download",
    });

    await user.click(
      await screen.findByLabelText(
        "Open html preview for Split dialog download",
      ),
    );
    await user.click(await screen.findByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    // Body previews stay disabled until the promoted lightbox finishes its exit
    // animation, so wait it out before the click that must reach the sidebar.
    const htmlChip = await screen.findByLabelText(
      "Open html preview for Split dialog download",
    );
    await waitFor(() => {
      expect(htmlChip).toBeEnabled();
    });
    click(htmlChip);

    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    // The same node: the click swapped sidebar content in place instead of
    // closing and reopening the pane.
    expect(screen.getByTestId("artifact-sidebar")).toBe(sidebar);
  });

  it("keeps a composer upload preview in the lightbox while the sidebar is open", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.upload.success({
      id: "upload-composer-photo",
      filename: "photo.png",
      contentType: "image/png",
      size: 2048,
      url: "https://example.com/photo.png",
    });
    setupHostedSiteArtifactPreview({
      filename: "composer-guard.html",
      htmlUrl: "https://composer-guard.sites.vm7.io",
      label: "Composer guard",
      runId: "run-composer-guard",
    });

    await user.click(
      await screen.findByLabelText("Open html preview for Composer guard"),
    );
    await user.click(await screen.findByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
    });

    await uploadFile(new File(["img"], "photo.png", { type: "image/png" }));
    const composerPreview = await screen.findByLabelText(
      "Open image preview for photo.png",
    );
    await waitFor(() => {
      expect(composerPreview).toBeEnabled();
    });
    click(composerPreview);

    // The pending upload opens the lightbox and leaves the sidebar on the
    // artifact the user was reading.
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-html"),
    ).toBeInTheDocument();
  });

  it("swaps the open artifact sidebar to a different clicked artifact", async () => {
    const user = userEvent.setup({ delay: null });
    const videoUrl = "https://cdn.vm7.io/artifacts/test/sidebar-swap/demo.mp4";
    const audioUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-swap/briefing.mp3";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-sidebar-swap",
          role: "assistant",
          content: `Generated preview links:\n\n${videoUrl}\n${audioUrl}`,
          runId: "run-sidebar-swap",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await screen.findByLabelText("Preview demo.mp4"));
    await user.click(await screen.findByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-video"),
      ).toBeInTheDocument();
    });

    // Body previews stay disabled until the promoted lightbox finishes its exit
    // animation, so wait it out before the click that must reach the sidebar.
    const audioChip = screen.getByLabelText(
      "Open audio preview for briefing.mp3",
    );
    await waitFor(() => {
      expect(audioChip).toBeEnabled();
    });
    click(audioChip);

    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-audio"),
      ).toBeInTheDocument();
    });
    expect(
      within(sidebar).queryByTestId("artifact-sidebar-body-video"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("artifact-sidebar")).toBe(sidebar);
  });

  it("opens media previews parsed from chat message links", async () => {
    await setupBodyLinkPreviews();

    const bodyVideoPreview = screen.getByLabelText("Preview demo.mp4");
    expect(bodyVideoPreview).toHaveClass(
      "aspect-[16/10]",
      "w-[min(100%,400px)]",
      "max-w-full",
      "bg-black",
    );
    expect(bodyVideoPreview).not.toHaveClass("w-[50px]");

    click(screen.getByLabelText("Open audio preview for briefing.mp3"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-audio")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Preview demo.mp4"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Video preview for demo.mp4"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    const chartImage = screen.getByAltText("chart.png");
    const chartPreview = chartImage.closest("button");
    if (!chartPreview) {
      throw new Error("Chart markdown image preview button not found");
    }
    fireEvent.load(chartImage);
    click(chartPreview);

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });
    const lightboxImage = screen.getByTestId("attachment-lightbox-image");
    expect(lightboxImage.tagName).toBe("IMG");
    expect(lightboxImage).toHaveAttribute("draggable", "false");
    expect(lightboxImage).not.toHaveClass("zero-native-media-interaction");
    expect(lightboxImage).toHaveStyle({
      pointerEvents: "auto",
      userSelect: "none",
      width: "100%",
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
  });

  it("renders short artifact video urls and links as preview cards", async () => {
    const bareVideoUrl = "https://cdn.vm7.io/artifacts/0123456789.mp4";
    const linkedVideoUrl = "https://cdn.vm7.io/artifacts/abcdefghij.mp4";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-short-artifact-video-links",
          role: "assistant",
          content: `${bareVideoUrl}\n[Generated clip](${linkedVideoUrl})`,
          runId: "run-short-artifact-video-links",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Preview 0123456789.mp4"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Preview abcdefghij.mp4")).toBeInTheDocument();
  });

  it("renders short Okou artifact cards without trusting lookalike hosts", async () => {
    const bareVideoUrl = "https://a.okou.io/0123456789.mp4";
    const linkedVideoUrl = "https://a.okou.io/abcdefghij.mp4";
    const legacyVideoUrl = "https://cdn.okou.io/artifacts/9876543210.mp4";
    const lookalikeVideoUrl =
      "https://a.okou.io.attacker.example/klmnopqrst.mp4";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-short-okou-artifact-video-links",
          role: "assistant",
          content: [
            bareVideoUrl,
            `[Generated clip](${linkedVideoUrl})`,
            legacyVideoUrl,
            `[Forged clip](${lookalikeVideoUrl})`,
          ].join("\n"),
          runId: "run-short-okou-artifact-video-links",
          createdAt: "2026-09-03T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Preview 0123456789.mp4"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Preview abcdefghij.mp4")).toBeInTheDocument();
    expect(screen.getByLabelText("Preview 9876543210.mp4")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Preview klmnopqrst.mp4"),
    ).not.toBeInTheDocument();
  });

  it("renders exact Okou public links without trusting lookalike hosts", async () => {
    context.mocks.browser.url(`https://app.okou.ai/chats/${THREAD_ID}`);
    const legacySiteUrl = "https://legacy-site.sites.vm0.io/";
    const okouSiteUrl = "https://okou-site.okou.app/";
    const okouArtifactUrl =
      "https://cdn.okou.io/artifacts/user_1/artifact_1/report.pdf";
    const lookalikeSiteUrl = "https://okou-site.okou.app.attacker.example/";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-okou-public-links",
          role: "assistant",
          content: [
            `[Legacy site](${legacySiteUrl})`,
            `[Okou site](${okouSiteUrl})`,
            `[Okou report](${okouArtifactUrl})`,
            `[Lookalike site](${lookalikeSiteUrl})`,
          ].join("\n"),
          runId: "run-okou-public-links",
          createdAt: "2026-08-20T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Open html preview for Legacy site"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Open html preview for Okou site"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open pdf preview for report.pdf"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Open html preview for Lookalike site"),
    ).not.toBeInTheDocument();
    const lookalikeLink = queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent === "Lookalike site";
    });
    expect(lookalikeLink).toHaveAttribute("href", lookalikeSiteUrl);

    click(screen.getByLabelText("Open pdf preview for report.pdf"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-document-frame"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTitle("report.pdf preview")).toHaveAttribute(
      "src",
      `${okouArtifactUrl}#navpanes=0`,
    );

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Okou site"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
        "src",
        okouSiteUrl,
      );
    });
  });

  it("recognizes historical Okou and preview file links without trusting Okou subdomains", async () => {
    context.mocks.browser.url(`https://app.vm0.ai/chats/${THREAD_ID}`);
    const okouFileUrl =
      "https://app.okou.ai/f/test-user/test-run/okou-history.png";
    const vm6FileUrl =
      "https://pr-27815-app.vm6.ai/f/test-user/test-run/vm6-preview.png";
    const vm7FileUrl =
      "https://staging-app.vm7.ai/f/test-user/test-run/vm7-preview.png";
    const forgedOkouFileUrl =
      "https://app.okou.ai.evil.example/f/test-user/test-run/forged.png";
    const arbitraryOkouFileUrl =
      "https://tenant.okou.ai/f/test-user/test-run/arbitrary.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-cross-brand-file-links",
          role: "assistant",
          content: [
            okouFileUrl,
            vm6FileUrl,
            vm7FileUrl,
            forgedOkouFileUrl,
            arbitraryOkouFileUrl,
          ].join("\n"),
          runId: "run-cross-brand-file-links",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByAltText("okou-history.png"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByAltText("vm6-preview.png")).toBeInTheDocument();
    expect(screen.getByAltText("vm7-preview.png")).toBeInTheDocument();
    expect(screen.queryByAltText("forged.png")).not.toBeInTheDocument();
    expect(screen.queryByAltText("arbitrary.png")).not.toBeInTheDocument();
  });

  it("requires complete urls for flat artifact preview cards", async () => {
    const incompletePath = "artifacts/97ngzkxdyn.mp4";
    const rootRelativePath = "/artifacts/97ngzkxdyn.mp4";
    const completeUrl = "https://cdn.vm7.io/artifacts/97ngzkxdyn.mp4";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-incomplete-short-artifact-video-links",
          role: "assistant",
          content: `${incompletePath}\n${rootRelativePath}\n${completeUrl}`,
          runId: "run-incomplete-short-artifact-video-links",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Preview 97ngzkxdyn.mp4"),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByLabelText("Preview 97ngzkxdyn.mp4")).toHaveLength(1);
    expect(
      screen.getByText(incompletePath, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(rootRelativePath, { exact: false }),
    ).toBeInTheDocument();
  });

  it("renders other short artifact urls with their preview ui", async () => {
    const urls = {
      audio: "https://cdn.vm7.io/artifacts/0000000001.mp3",
      markdown: "https://cdn.vm7.io/artifacts/0000000002.md",
      text: "https://cdn.vm7.io/artifacts/0000000003.txt",
      json: "https://cdn.vm7.io/artifacts/0000000004.json",
      csv: "https://cdn.vm7.io/artifacts/0000000005.csv",
      pdf: "https://cdn.vm7.io/artifacts/0000000006.pdf",
      html: "https://cdn.vm7.io/artifacts/0000000007.html",
      file: "https://cdn.vm7.io/artifacts/0000000008.bin",
      image: "https://cdn.vm7.io/artifacts/0000000009.png",
    } as const;
    context.mocks.http.get(urls.markdown, () => {
      return new Response("# Notes", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(urls.text, () => {
      return new Response("Transcript", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    context.mocks.http.get(urls.json, () => {
      return new Response('{"status":"ready"}', {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.http.get(urls.csv, () => {
      return new Response("metric,value\nactivation,87", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-other-short-artifact-links",
          role: "assistant",
          content: `${urls.audio}\n[Notes](${urls.markdown})\n${urls.text}\n[Status](${urls.json})\n${urls.csv}\n[Plan](${urls.pdf})\n[Short site](${urls.html})\n${urls.file}\n${urls.image}`,
          runId: "run-other-short-artifact-links",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Open audio preview for 0000000001.mp3"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Open markdown preview for 0000000002.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open text preview for 0000000003.txt"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open json preview for 0000000004.json"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open csv preview for 0000000005.csv"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open pdf preview for 0000000006.pdf"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open html preview for Short site"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Preview 0000000008.bin")).toBeInTheDocument();
    expect(screen.getByAltText("0000000009.png")).toBeInTheDocument();
  });

  it("opens document previews parsed from chat message links", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    await setupBodyLinkPreviews();

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(
        screen.getByText("Body link rollout is ready."),
      ).toBeInTheDocument();
    });
    const diagramUrl = (await screen.findByAltText("Diagram")).getAttribute(
      "src",
    );
    expect(diagramUrl).toContain("blob:mock-download-");
    expect(objectUrls.revokedUrls).not.toContain(diagramUrl);

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(objectUrls.revokedUrls).toContain(diagramUrl);
    });
    expect(context.signal.aborted).toBeFalsy();

    click(screen.getByLabelText("Open csv preview for launch-metrics.csv"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("activation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open pdf preview for rollout-plan.pdf"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-document-frame"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Launch site"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-body-html"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Preview archive.bin"));

    await screen.findByTestId("attachment-lightbox");
    click(screen.getByLabelText("Download options"));
    await waitFor(() => {
      expect(
        queryAllByRoleFast("menuitem").some((element) => {
          return element.textContent?.trim() === "Download";
        }),
      ).toBeTruthy();
    });
    const downloadItem = queryAllByRoleFast("menuitem").find((element) => {
      return element.textContent?.trim() === "Download";
    });
    if (!downloadItem) {
      throw new Error("Download menu item not found");
    }
    click(downloadItem);

    await waitFor(() => {
      expect(objectUrls.downloads).toHaveLength(1);
    });
    expect(objectUrls.downloads[0]).toMatchObject({
      url: BODY_LINK_PREVIEWS.archive,
      filename: "archive.bin",
      blob: null,
    });
    expect(screen.queryByText("Download failed")).not.toBeInTheDocument();
  });

  it("renders bare image URLs through markdown image preview", async () => {
    const imageUrl = "https://cdn.vm7.io/artifacts/test/body-image/chart.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-stable-image-preview",
          role: "assistant",
          content: `Chart preview:\n\n${imageUrl}`,
          runId: "run-stable-image-preview",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const image = await screen.findByAltText("chart.png");
    const preview = image.closest("button");
    if (!preview) {
      throw new Error("Markdown image preview button not found");
    }
    expect(image).toHaveAttribute("src", imageUrl);
    expect(
      within(preview).getByTestId("markdown-image-preview-loading"),
    ).toBeInTheDocument();

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("markdown-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
    click(preview);

    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(
      within(lightbox).getByTestId("attachment-lightbox-image"),
    ).toHaveAttribute("src", imageUrl);
  });

  it("renders canonical user markdown image syntax literally", async () => {
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/user-markdown-image/kitten-1280x720.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-user-markdown-image",
          role: "user",
          content: `![1280x720](${imageUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByText(`![1280x720](${imageUrl})`),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByAltText("1280x720")).toBeNull();
  });

  it("hides the share action when the api reports no public attachment url", async () => {
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      const fileId = new URL(request.url).searchParams.get("file_id") ?? "";
      return HttpResponse.json({ url: presignedFileUrl(fileId) });
    });
    context.mocks.http.get(PRESIGNED_FILE_PATTERN, () => {
      return new Response("# Release notes\n\nThe rollout is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-no-public-url",
          role: "user",
          content: "Review this attachment",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-markdown",
              filenameSnapshot: "release-notes.md",
              contentType: "text/markdown",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    click(
      await screen.findByLabelText(
        "Open markdown preview for release-notes.md",
      ),
    );

    // The body renders from the same resolution that would have carried a
    // share URL, so its arrival means "no share URL" is settled, not pending.
    await waitFor(() => {
      expect(screen.getByText("The rollout is ready.")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Share")).toBeNull();
  });

  it("shares a public artifact by its cdn url", async () => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    context.mocks.browser.blobDownload();
    await setupBodyLinkPreviews();

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });

    // An artifact that already carries a public address shares that address
    // directly, without waiting on the private-attachment resolution.
    const shareLink = screen.getByLabelText("Share");
    expect(shareLink).toHaveAttribute("href", BODY_LINK_PREVIEWS.markdown);

    click(shareLink);

    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });
    expect(clipboard.writes).toStrictEqual([BODY_LINK_PREVIEWS.markdown]);
  });

  it("opens canonical text previews and downloads a private generic file from its presigned url", async () => {
    const releaseNotesUrl = canonicalUserMessageFileUrl("attachment-markdown");
    const browser = context.mocks.browser.blobDownload();
    const clipboard = context.mocks.browser.clipboardWriteText();
    context.mocks.http.get(PRESIGNED_FILE_PATTERN, ({ params }) => {
      const fileId = params.fileId;
      if (fileId === "attachment-markdown") {
        return new Response("# Release notes\n\nThe rollout is ready.", {
          headers: { "Content-Type": "text/markdown" },
        });
      }
      if (fileId === "attachment-text") {
        return new Response("Meeting transcript\nDecision: ship", {
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (fileId === "attachment-download") {
        return new Response("archive bytes", {
          headers: { "Content-Type": "application/zip" },
        });
      }
      return new Response(null, { status: 500 });
    });
    // Guard against regressing to the canonical route, which needs an
    // Authorization header that the download fetch does not carry.
    context.mocks.http.get("/api/web/download-file", () => {
      return new Response(null, { status: 500 });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-text-previews",
          role: "user",
          content: "Review these text attachments",
          fileParts: [
            {
              type: "file",
              fileId: "attachment-markdown",
              filenameSnapshot: "release-notes.md",
              contentType: "text/markdown",
            },
            {
              type: "file",
              fileId: "attachment-text",
              filenameSnapshot: "transcript.txt",
              contentType: "text/plain",
            },
            {
              type: "file",
              fileId: "attachment-download",
              filenameSnapshot: "source-assets.zip",
              contentType: "application/zip",
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByText("Review these text attachments"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for release-notes.md"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open text preview for transcript.txt"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Download source-assets.zip"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("The rollout is ready.")).toBeInTheDocument();
    });

    const shareLink = screen.getByLabelText("Share");
    expect(shareLink.tagName).toBe("A");
    // The canonical URL answers only to the owner's credentials, so sharing it
    // hands the recipient a 401 instead of the file.
    expect(shareLink).not.toHaveAttribute("href", releaseNotesUrl);
    expect(shareLink).toHaveAttribute(
      "href",
      publicFileUrl("attachment-markdown"),
    );

    click(shareLink);

    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });
    expect(clipboard.writes).toStrictEqual([
      publicFileUrl("attachment-markdown"),
    ]);

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open text preview for transcript.txt"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText(/Decision: ship/u)).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Download source-assets.zip"));

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]).toMatchObject({
      url: presignedFileUrl("attachment-download"),
      filename: "source-assets.zip",
      blob: null,
    });
    expect(screen.queryByText("Download failed")).not.toBeInTheDocument();
  });
});
