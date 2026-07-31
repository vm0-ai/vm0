import {
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  type ChatThreadArtifactFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

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
    updatedAt: "2026-03-10T00:00:00Z",
  });
});

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
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

function clipboardFileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => {
      return file;
    },
  } as DataTransferItem;
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

  it("opens, zooms, and closes an uploaded image preview", async () => {
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
    const imageUrl = "https://cdn.vm7.io/artifacts/test/photo/photo.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-image-then-text",
          role: "user",
          content: "Review this image",
          attachFiles: [
            {
              id: "attachment-photo",
              filename: "photo.png",
              contentType: "image/png",
              size: 2048,
              url: imageUrl,
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const image = await screen.findByAltText("photo.png");
    const preview = image.closest("a");
    const text = await screen.findByText("Review this image");
    const textBubble = text.closest(".zero-chat-bubble-user");

    expect(preview).not.toBeNull();
    expect(textBubble).not.toBeNull();
    expect(preview?.closest(".zero-chat-bubble-user")).toBeNull();
    expect(
      preview!.compareDocumentPosition(textBubble!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the user image preview frame stable while the image loads", async () => {
    const imageUrl = "https://cdn.vm7.io/artifacts/test/stable-photo/photo.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-stable-photo",
          role: "user",
          content: "Review this image",
          attachFiles: [
            {
              id: "attachment-stable-photo",
              filename: "photo.png",
              contentType: "image/png",
              size: 2048,
              url: imageUrl,
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
    const spacer = preview.querySelector('span[aria-hidden="true"]');
    expect(preview).toHaveClass(
      "relative",
      "inline-flex",
      "aspect-[10/9]",
      "w-[50px]",
    );
    expect(spacer).toHaveClass("block", "h-full", "w-full");
    expect(
      within(preview).getByTestId("chat-image-preview-loading"),
    ).toHaveClass("absolute", "inset-0");
    expect(image).toHaveClass("absolute", "inset-0", "opacity-0");

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("chat-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
    expect(preview.querySelector('span[aria-hidden="true"]')).toBe(spacer);
    expect(image).not.toHaveClass("opacity-0");
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
          slackMessagePermalink:
            "https://example.slack.com/archives/C123/p123456789",
          attachFiles: [
            {
              id: assetId,
              filename: "source-notes.md",
              contentType: "text/markdown",
              size: 256,
              url: `/api/zero/web/download-file?file_id=${assetId}`,
              assetRef: {
                id: assetId,
                classification: "input",
                access: "private",
                materialization: { status: "ready" },
                provenance: { provider: "slack" },
              },
            },
          ],
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

  it("shows an explicit unavailable state for a failed Slack import", async () => {
    const assetId = "a0000000-0000-4000-a000-000000000052";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-failed-slack-input",
          role: "user",
          content: "Use this attachment",
          slackMessagePermalink:
            "https://example.slack.com/archives/C123/p123456790",
          attachFiles: [
            {
              id: assetId,
              filename: "expired.pdf",
              contentType: "application/pdf",
              size: 512,
              url: `/api/zero/web/download-file?file_id=${assetId}`,
              assetRef: {
                id: assetId,
                classification: "input",
                access: "private",
                materialization: {
                  status: "failed",
                  error: {
                    code: "download-failed",
                    message: "Slack no longer has this file",
                    retryable: false,
                  },
                },
                provenance: { provider: "slack" },
              },
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const unavailable = await screen.findByRole("alert");
    expect(unavailable).toHaveTextContent("expired.pdf");
    expect(unavailable).toHaveTextContent("Attachment unavailable");
    expect(unavailable).toHaveAttribute(
      "title",
      "Slack no longer has this file",
    );
    expect(
      screen.queryByLabelText("Open pdf preview for expired.pdf"),
    ).toBeNull();
  });

  it("renders an Agent-published attachment on an otherwise empty reply", async () => {
    const assetId = "a0000000-0000-4000-a000-000000000053";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-canonical-agent-output-completed",
          role: "assistant",
          content: null,
          runId: "run-canonical-output",
          runLifecycleEvent: "completed",
          attachFiles: [
            {
              id: assetId,
              filename: "final-report.pdf",
              contentType: "application/pdf",
              size: 4096,
              url: "https://cdn.vm7.io/artifacts/test/final-report.pdf",
              assetRef: {
                id: assetId,
                classification: "published-output",
                access: "published",
                materialization: { status: "ready" },
                provenance: { provider: "agent" },
              },
            },
          ],
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByLabelText("Open pdf preview for final-report.pdf"),
    ).resolves.toBeInTheDocument();
  });

  it("renders canonical user video attachments at the same size as image attachments", async () => {
    const imageUrl = "https://cdn.vm7.io/artifacts/test/media/photo.png";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/media/screencast.mp4";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-image-video-attachments",
          role: "user",
          content: "this is the screencast",
          attachFiles: [
            {
              id: "attachment-photo",
              filename: "photo.png",
              contentType: "image/png",
              size: 2048,
              url: imageUrl,
            },
            {
              id: "attachment-screencast",
              filename: "screencast.mp4",
              contentType: "video/mp4",
              size: 4096,
              url: videoUrl,
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

  it("opens persisted canonical audio, video, and document attachments", async () => {
    const audioUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-audio/briefing.mp3";
    const videoUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-video/demo.mp4";
    const jsonUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-json/status.json";
    context.mocks.http.get(jsonUrl, () => {
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
          attachFiles: [
            {
              id: "attachment-audio",
              filename: "briefing.mp3",
              contentType: "audio/mpeg",
              size: 1024,
              url: audioUrl,
            },
            {
              id: "attachment-video",
              filename: "demo.mp4",
              contentType: "video/mp4",
              size: 2048,
              url: videoUrl,
            },
            {
              id: "attachment-json",
              filename: "status.json",
              contentType: "application/json",
              size: 32,
              url: jsonUrl,
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
    const csvUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-csv/launch-metrics.csv";
    const pdfUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-pdf/launch-plan.pdf";
    const htmlUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-html/launch-site.html";
    context.mocks.http.get(csvUrl, () => {
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
          attachFiles: [
            {
              id: "attachment-csv",
              filename: "launch-metrics.csv",
              contentType: "text/csv",
              size: 38,
              url: csvUrl,
            },
            {
              id: "attachment-pdf",
              filename: "launch-plan.pdf",
              contentType: "application/pdf",
              size: 2048,
              url: pdfUrl,
            },
            {
              id: "attachment-html",
              filename: "launch-site.html",
              contentType: "text/html",
              size: 4096,
              url: htmlUrl,
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
    expect(iframe).toHaveAttribute("src", `${pdfUrl}#navpanes=0`);
    expect(iframe).toHaveClass("h-full", "min-h-0", "border-0");

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for launch-site.html"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-body-html"),
      ).toBeInTheDocument();
    });
  });

  it("navigates modal image artifacts within the current run", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/image-navigation/first.png";
    const notesUrl =
      "https://cdn.vm7.io/artifacts/test/image-navigation/notes.md";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/image-navigation/second.png";
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
          attachFiles: [
            {
              id: "artifact-first-image",
              filename: "first.png",
              contentType: "image/png",
              size: 128,
              url: firstImageUrl,
            },
            {
              id: "artifact-notes",
              filename: "notes.md",
              contentType: "text/markdown",
              size: 64,
              url: notesUrl,
            },
            {
              id: "artifact-second-image",
              filename: "second.png",
              contentType: "image/png",
              size: 256,
              url: secondImageUrl,
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
    mockChatLifecycle(context, {
      threadId: leftThreadId,
      threadTitle: "Left image thread",
    });
    context.mocks.api(
      chatThreadEventsContract.list,
      ({ params, query, respond }) => {
        if (query.beforeSeqId !== undefined) {
          return respond(200, { events: [] });
        }
        if (query.sinceSeqId !== undefined) {
          return respond(200, { events: [] });
        }
        const secondImageUrl =
          params.threadId === leftThreadId
            ? leftSecondImageUrl
            : params.threadId === rightThreadId
              ? rightSecondImageUrl
              : undefined;
        if (!secondImageUrl) {
          return respond(200, { events: [] });
        }
        return respond(200, {
          events: [
            {
              id: `msg-${params.threadId}`,
              threadId: params.threadId,
              eventType: "output.message",
              content: `Generated images:\n\n${firstImageUrl}\n${secondImageUrl}`,
              runId: `run-${params.threadId}`,
              seqId: 1,
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${leftThreadId}?sidebar=${rightThreadId}`,
    });

    const threadRegions = await screen.findAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
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
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/user-image-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/user-image-navigation/second.png";
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
          attachFiles: [
            {
              id: "user-first-image",
              filename: "first.png",
              contentType: "image/png",
              size: 128,
              url: firstImageUrl,
            },
            {
              id: "user-second-image",
              filename: "second.png",
              contentType: "image/png",
              size: 256,
              url: secondImageUrl,
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
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/fullscreen-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/fullscreen-navigation/second.png";
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
          attachFiles: [
            {
              id: "artifact-fullscreen-first-image",
              filename: "first.png",
              contentType: "image/png",
              size: 128,
              url: firstImageUrl,
            },
            {
              id: "artifact-fullscreen-second-image",
              filename: "second.png",
              contentType: "image/png",
              size: 256,
              url: secondImageUrl,
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

  it("opens presentation HTML preview controls from chat message links", async () => {
    const presentationUrl =
      "https://cdn.vm7.io/artifacts/test/body-presentation/quarterly-roadmap.html";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-presentation",
            files: [artifactFile(presentationUrl)],
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

  it("opens only the dialog download menu when the same artifact is in split view", async () => {
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
    await user.click(
      await screen.findByLabelText(
        "Open html preview for Split dialog download",
      ),
    );
    const lightbox = await screen.findByTestId("attachment-lightbox");
    const sidebarDownload = within(sidebar).getByLabelText("Download artifact");
    const dialogDownload = within(lightbox).getByLabelText("Download options");

    await user.click(dialogDownload);

    await waitFor(() => {
      expect(dialogDownload).toHaveAttribute("aria-expanded", "true");
      expect(sidebarDownload).toHaveAttribute("aria-expanded", "false");
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(
        screen.getAllByTestId("artifact-download-menu-dismiss-layer"),
      ).toHaveLength(1);
    });
  });

  it("opens media and file previews parsed from chat message links", async () => {
    const audioUrl =
      "https://cdn.vm7.io/artifacts/test/body-audio/briefing.mp3";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/body-video/demo.mp4";
    const imageUrl = "https://cdn.vm7.io/artifacts/test/body-image/chart.png";
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/body-markdown/release-notes.md";
    const csvUrl =
      "https://cdn.vm7.io/artifacts/test/body-csv/launch-metrics.csv";
    const pdfUrl =
      "https://cdn.vm7.io/artifacts/test/body-pdf/rollout-plan.pdf";
    const htmlUrl =
      "https://cdn.vm7.io/artifacts/test/body-html/launch-site.html";
    const archiveUrl =
      "https://cdn.vm7.io/artifacts/test/body-file/archive.bin";
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nBody link rollout is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(csvUrl, () => {
      return new Response("metric,value\nactivation,87", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(archiveUrl, () => {
      return new Response(null, { status: 500 });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-body-preview-links",
          role: "assistant",
          content: `Generated preview links:\n\n${audioUrl}\n${videoUrl}\n${imageUrl}\n${markdownUrl}\n${csvUrl}\n${pdfUrl}\n[Launch site](${htmlUrl})\n${archiveUrl}`,
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
      expect(screen.getByLabelText("Download archive.bin")).toBeInTheDocument();
    });

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

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(
        screen.getByText("Body link rollout is ready."),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

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

    click(screen.getByLabelText("Download archive.bin"));

    await waitFor(() => {
      expect(screen.getByText("Download failed")).toBeInTheDocument();
    });
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
    const spacer = preview.querySelector('span[aria-hidden="true"]');
    expect(preview).toHaveClass(
      "relative",
      "inline-flex",
      "aspect-[10/9]",
      "w-[200px]",
    );
    expect(spacer).toHaveClass("block", "h-full", "w-full");
    expect(
      within(preview).getByTestId("markdown-image-preview-loading"),
    ).toHaveClass("absolute", "inset-0");
    expect(image).toHaveAttribute("src", imageUrl);
    expect(image).toHaveClass("absolute", "inset-0", "opacity-0");

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("markdown-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
    expect(preview.querySelector('span[aria-hidden="true"]')).toBe(spacer);
    expect(image).not.toHaveClass("opacity-0");
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

  it("opens canonical markdown and text previews, shares a document link, and reports download failures", async () => {
    const releaseNotesUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-markdown/release-notes.md";
    const transcriptUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-text/transcript.txt";
    const archiveUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-file/archive.bin";
    context.mocks.browser.clipboardWriteText();
    context.mocks.http.get(releaseNotesUrl, () => {
      return new Response("# Release notes\n\nThe rollout is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(transcriptUrl, () => {
      return new Response("Meeting transcript\nDecision: ship", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    context.mocks.http.get(archiveUrl, () => {
      return new Response(null, { status: 500 });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: "msg-text-previews",
          role: "user",
          content: "Review these text attachments",
          attachFiles: [
            {
              id: "attachment-markdown",
              filename: "release-notes.md",
              contentType: "text/markdown",
              size: 42,
              url: releaseNotesUrl,
            },
            {
              id: "attachment-text",
              filename: "transcript.txt",
              contentType: "text/plain",
              size: 33,
              url: transcriptUrl,
            },
            {
              id: "attachment-file",
              filename: "archive.bin",
              contentType: "application/octet-stream",
              size: 4096,
              url: archiveUrl,
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
      expect(screen.getByLabelText("Download archive.bin")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("The rollout is ready.")).toBeInTheDocument();
    });

    const shareLink = screen.getByLabelText("Share");
    expect(shareLink.tagName).toBe("A");
    expect(shareLink).toHaveAttribute("href", releaseNotesUrl);

    click(shareLink);

    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });

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

    click(screen.getByLabelText("Download archive.bin"));

    await waitFor(() => {
      expect(screen.getByText("Download failed")).toBeInTheDocument();
    });
  });
});
