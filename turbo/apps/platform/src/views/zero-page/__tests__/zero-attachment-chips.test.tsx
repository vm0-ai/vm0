import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { Markdown } from "../../components/markdown.tsx";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  HTML_DOM_EDIT_SELECTED_ATTR,
  HTML_DOM_EDIT_OVERLAY_ATTR,
  HTML_DOM_NODE_ID_ATTR,
} from "../html-dom-edit-protocol.ts";

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

function presentationHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <title>Quarterly roadmap</title>
    <script id="vm0-deck-metadata" type="application/json">
      {
        "kind": "presentation-html",
        "editProtocolVersion": 1,
        "slides": {
          "slide-intro": { "speakerNotes": "Open with launch metrics." }
        }
      }
    </script>
  </head>
  <body>
    <section data-vm0-slide data-slide-id="slide-intro">
      <h1 data-vm0-editable="text" data-vm0-edit-id="title">Quarterly roadmap</h1>
      <p data-vm0-editable="text" data-vm0-edit-id="summary">Launch metrics are ahead of plan.</p>
    </section>
  </body>
</html>`;
}

function setupHostedSiteArtifactPreview({
  featureSwitches = {
    [FeatureSwitchKey.HtmlArtifactCommentEditing]: true,
  },
  filename,
  html,
  htmlUrl,
  label,
  path = `/chats/${THREAD_ID}`,
  runId,
}: {
  featureSwitches?: Parameters<typeof detachedSetupPage>[0]["featureSwitches"];
  filename: string;
  html?: string;
  htmlUrl: string;
  label: string;
  path?: string;
  runId: string;
}): void {
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
            artifactFile(htmlUrl, {
              artifactKind: "hosted-site",
              filename,
            }),
          ],
        },
      ],
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatMessages: [
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
    featureSwitches,
    path,
  });
}

function expectHostedSiteEditingHeader({
  fullscreen,
}: {
  fullscreen: boolean;
}): void {
  const sidebar = screen.getByTestId("artifact-sidebar");
  const fullscreenLabel = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
  expect(
    within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
  ).toHaveTextContent("Editing");
  const exitEdit = within(sidebar).getByTestId(
    "artifact-sidebar-exit-html-edit",
  );
  expect(exitEdit).toHaveAttribute("aria-label", "Exit editing");
  expect(
    within(sidebar)
      .getByTestId("artifact-sidebar-html-edit-status")
      .compareDocumentPosition(within(sidebar).getByLabelText(fullscreenLabel)),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    within(sidebar)
      .getByLabelText(fullscreenLabel)
      .compareDocumentPosition(exitEdit),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(within(sidebar).queryByLabelText("Edit page")).toBeNull();
  expect(within(sidebar).queryByLabelText("Open in new tab")).toBeNull();
  expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
  expect(within(sidebar).queryByLabelText("Download artifact")).toBeNull();
  expect(within(sidebar).queryByLabelText("Close artifact")).toBeNull();
}

beforeEach(() => {
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    updatedAt: "2026-03-10T00:00:00Z",
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

function mockElementRect(
  element: Element,
  {
    height,
    left,
    top,
    width,
  }: { height: number; left: number; top: number; width: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => {
          return {};
        },
        top,
        width,
        x: left,
        y: top,
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

    const composer = screen.getByPlaceholderText(PLACEHOLDER);
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
      expect(composer).toHaveValue("Pasted context");
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
      chatMessages: [
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

  it("opens persisted audio, video, and document attachments from chat history", async () => {
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
      chatMessages: [
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

  it("opens persisted csv, pdf, and html document previews from chat history", async () => {
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
      chatMessages: [
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
      chatMessages: [
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
      featureSwitches: {
        [FeatureSwitchKey.ImageArtifactKeyboardNavigation]: true,
      },
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

  it("navigates modal images generated in an assistant message body", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/second.png";
    // A generated image that exists in the run artifacts but is NOT referenced
    // in the message body. It must be excluded from message-scoped navigation.
    const unreferencedImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-navigation/unreferenced.png";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
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
      chatMessages: [
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
      featureSwitches: {
        [FeatureSwitchKey.ImageArtifactKeyboardNavigation]: true,
      },
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
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
    expect(screen.getByLabelText("Next image artifact")).toBeInTheDocument();

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

  it("navigates human-uploaded images that are not run artifacts", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/user-image-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/user-image-navigation/second.png";
    // The images the user attached are NOT part of the thread's run artifacts;
    // they resolve from the user artifacts bucket. Navigation must still work.
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
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
      featureSwitches: {
        [FeatureSwitchKey.ImageArtifactKeyboardNavigation]: true,
      },
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
      chatMessages: [
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
      featureSwitches: {
        [FeatureSwitchKey.ImageArtifactKeyboardNavigation]: true,
      },
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

  it("hides image navigation when the feature switch is disabled", async () => {
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/navigation-disabled/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/navigation-disabled/second.png";
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-navigation-disabled",
            files: [
              artifactFile(firstImageUrl, {
                id: "artifact-disabled-first-image",
                filename: "first.png",
                contentType: "image/png",
                size: 128,
              }),
              artifactFile(secondImageUrl, {
                id: "artifact-disabled-second-image",
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
      chatMessages: [
        {
          id: "msg-navigation-disabled",
          role: "user",
          content: "Review these images",
          attachFiles: [
            {
              id: "artifact-disabled-first-image",
              filename: "first.png",
              contentType: "image/png",
              size: 128,
              url: firstImageUrl,
            },
            {
              id: "artifact-disabled-second-image",
              filename: "second.png",
              contentType: "image/png",
              size: 256,
              url: secondImageUrl,
            },
          ],
          runId: "run-navigation-disabled",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    // No featureSwitches override: the switch defaults to off in tests.
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    click(await screen.findByLabelText("Preview first.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });

    expect(screen.queryByLabelText("Next image artifact")).toBeNull();
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
  });

  it("opens presentation artifact controls from chat message links", async () => {
    const presentationUrl =
      "https://cdn.vm7.io/artifacts/test/body-presentation/quarterly-roadmap.html";
    const html = presentationHtml();
    context.mocks.http.get(presentationUrl, () => {
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    });
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    });
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
      chatMessages: [
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
      expect(screen.getByLabelText("Edit presentation")).toBeInTheDocument();
      expect(screen.getByLabelText("Open in split view")).toBeInTheDocument();
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
      "tabindex",
      "-1",
    );

    click(screen.getByLabelText("Enter fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Exit fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });

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

    click(screen.getByLabelText("Open html preview for Quarterly roadmap"));
    click(await screen.findByLabelText("Edit presentation"));

    await waitFor(() => {
      expect(screen.getByText("Presentation editor")).toBeInTheDocument();
    });
  });

  it("prepares a hosted-site HTML comment edit session", async () => {
    const htmlUrl = "https://launch-site-demo.sites.vm7.io";
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
      expect(new URL(request.url).searchParams.get("url")).toBe(htmlUrl);
      return new Response(
        `<!doctype html>
        <html>
          <head><title>Launch site</title></head>
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
            runId: "run-hosted-site",
            files: [
              artifactFile(htmlUrl, {
                artifactKind: "hosted-site",
                filename: "launch-site.html",
              }),
            ],
          },
        ],
      });
    });
    context.mocks.api(
      zeroHostContract.createHtmlEditDraft,
      ({ body, respond }) => {
        expect(body.comments).toStrictEqual([
          {
            id: expect.any(String),
            targetNodeIds: [expect.any(String)],
            comment: "Make the hero headline shorter",
          },
          {
            id: expect.any(String),
            targetNodeIds: [expect.any(String)],
            comment: "Make the body copy warmer",
          },
        ]);
        expect(body.html).toContain("Launch faster");
        return respond(200, {
          kind: "html-edit-draft",
          version: 1,
          html: "<!doctype html><html><body><main><h1>Launch sooner</h1><p>Ship the first version today.</p></main></body></html>",
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-hosted-site-artifact",
          role: "assistant",
          content: `[Launch site](${htmlUrl})`,
          runId: "run-hosted-site",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.HtmlArtifactCommentEditing]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for Launch site"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Launch site"));

    await waitFor(() => {
      expect(screen.getByLabelText("Edit page")).toBeInTheDocument();
      expect(screen.queryByLabelText("Edit presentation")).toBeNull();
    });

    click(screen.getByLabelText("Edit page"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(sidebar).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Editing");
      const exitEdit = within(sidebar).getByTestId(
        "artifact-sidebar-exit-html-edit",
      );
      expect(exitEdit).toHaveAttribute("aria-label", "Exit editing");
      expect(
        within(sidebar)
          .getByTestId("artifact-sidebar-html-edit-status")
          .compareDocumentPosition(
            within(sidebar).getByLabelText("Enter fullscreen"),
          ),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        within(sidebar)
          .getByLabelText("Enter fullscreen")
          .compareDocumentPosition(exitEdit),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(within(sidebar).queryByLabelText("Edit page")).toBeNull();
      expect(within(sidebar).queryByLabelText("Open in new tab")).toBeNull();
      expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Download artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Close artifact")).toBeNull();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Exit comment mode")).toBeNull();
    });
    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    let title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    fireEvent.click(title!);

    await waitFor(() => {
      expect(
        screen.getByTestId("html-dom-comment-popover"),
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Describe the change you want"),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup({ delay: null });
    const commentTextArea = screen.getByTestId("html-dom-comment-textarea");
    expect(commentTextArea).toHaveFocus();
    await user.type(commentTextArea, "Make the headline shorter");
    fireEvent.keyDown(commentTextArea, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("html-dom-comment-popover")).toBeInTheDocument();
    expect(
      frame.contentDocument?.querySelector(
        "[data-testid='html-dom-comment-marker']",
      ),
    ).toBeNull();

    fireEvent.keyDown(commentTextArea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
    });

    await waitFor(() => {
      expect(
        frame.contentDocument?.querySelector(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).not.toBeNull();
    });
    const marker = frame.contentDocument!.querySelector<HTMLElement>(
      "[data-testid='html-dom-comment-marker']",
    )!;
    const tag = marker.querySelector<HTMLElement>(
      "[data-testid='html-dom-comment-tag']",
    )!;
    const tagText = tag.querySelector<HTMLElement>(
      "[data-testid='html-dom-comment-tag-text']",
    )!;
    const deleteButton = marker.querySelector<HTMLElement>(
      "[data-testid='html-dom-comment-delete']",
    )!;
    const deleteIcon = deleteButton.querySelector<SVGSVGElement>("svg")!;
    expect(marker).toHaveAttribute(HTML_DOM_EDIT_OVERLAY_ATTR);
    expect(marker).not.toHaveAttribute("title");
    expect(marker).toHaveAttribute("data-vm0-html-comment-placement", "right");
    expect(
      marker.querySelector("[data-testid='html-dom-comment-anchor']"),
    ).not.toBeNull();
    expect(
      marker.querySelector("[data-testid='html-dom-comment-leader']"),
    ).not.toBeNull();
    expect(deleteButton.parentElement).toBe(tag);
    expect(deleteButton.style.right).toBe("8px");
    expect(deleteButton.style.top).toBe("50%");
    expect(deleteButton.style.width).toBe("24px");
    expect(deleteButton.style.height).toBe("24px");
    expect(deleteButton.style.alignItems).toBe("center");
    expect(deleteButton.style.justifyContent).toBe("center");
    expect(deleteButton.style.transform).toBe("translateY(-50%)");
    expect(deleteButton.style.opacity).toBe("0");
    expect(deleteButton.style.pointerEvents).toBe("none");
    expect(deleteIcon).not.toBeNull();
    expect(deleteIcon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(deleteIcon.style.width).toBe("14px");
    expect(deleteIcon.style.height).toBe("14px");
    expect(frame.contentDocument?.head.textContent).toContain(
      "[data-vm0-html-comment-target-node-id]:hover [data-vm0-html-comment-delete-id]",
    );
    expect(frame.contentDocument?.head.textContent).toContain(":hover");
    expect(tag).toHaveTextContent("Make the headline shorter");
    expect(tagText).toHaveTextContent("Make the headline shorter");
    expect(tag.style.maxWidth).toBe("136px");
    expect(tag.style.height).toBe("56px");
    expect(tag.style.overflow).toBe("hidden");
    expect(tag.style.justifyContent).toBe("center");
    expect(tag.style.textAlign).toBe("center");
    expect(tagText.style.whiteSpace).toBe("normal");
    expect(tagText.style.overflowWrap).toBe("anywhere");
    expect(tagText.style.padding).toBe("0px 22px");
    expect(tagText.style.textAlign).toBe("center");
    expect(tagText.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
    expect(screen.getByTestId("html-dom-comment-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    expect(
      screen.getByTestId("html-dom-toolbar-comments-count"),
    ).toHaveTextContent("1");

    title!.textContent = "Changed during edit";
    click(screen.getByTestId("html-dom-toolbar-discard"));
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expect(frame.contentDocument?.querySelector("h1")).toHaveTextContent(
        "Launch faster",
      );
      expect(
        frame.contentDocument?.querySelector(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toBeNull();
      expect(
        screen.queryByTestId("html-dom-toolbar-comments-count"),
      ).toBeNull();
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeDisabled();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Editing");
    });

    title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: 24,
      width: 32,
    });
    fireEvent.click(title!);
    const nextCommentTextArea = await screen.findByTestId(
      "html-dom-comment-textarea",
    );
    await user.type(nextCommentTextArea, "Make the headline shorter");
    fireEvent.keyDown(nextCommentTextArea, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
      expect(
        frame.contentDocument?.querySelector(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).not.toBeNull();
      expect(
        frame.contentDocument?.querySelector(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveAttribute("data-vm0-html-comment-placement", "bottom");
    });

    fireEvent.mouseOver(title!);
    await waitFor(() => {
      const popover = screen.getByTestId("html-dom-comment-popover");
      const textArea = screen.getByTestId("html-dom-comment-textarea");
      expect(popover).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Describe the change you want"),
      ).toBeInTheDocument();
      expect(textArea).toHaveValue("Make the headline shorter");
      expect(textArea).toHaveAttribute("readonly");
      expect(screen.getByTestId("html-dom-comment-add")).toBeDisabled();
      expect(screen.queryByTestId("html-dom-comment-send")).toBeNull();
      expect(screen.queryByTestId("html-dom-edit-prepared")).toBeNull();
      expect(
        screen.queryByLabelText("Close comment popover"),
      ).not.toBeInTheDocument();
      expect(popover.querySelectorAll("textarea")).toHaveLength(1);
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(screen.queryByTestId("html-dom-color-popover")).toBeNull();
      expect(popover).toHaveClass("rounded-[28px]");
    });
    fireEvent.click(screen.getByTestId("html-dom-comment-textarea"));
    await waitFor(() => {
      const textArea = screen.getByTestId("html-dom-comment-textarea");
      expect(textArea).toHaveValue("Make the headline shorter");
      expect(textArea).not.toHaveAttribute("readonly");
      expect(textArea).toHaveFocus();
      expect(screen.getByTestId("html-dom-comment-add")).toBeEnabled();
    });
    await fill(
      screen.getByTestId("html-dom-comment-textarea"),
      "Make the hero headline shorter",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
    });

    const updatedCommentMarker =
      frame.contentDocument?.querySelector<HTMLElement>(
        "[data-testid='html-dom-comment-marker']",
      );
    expect(updatedCommentMarker).not.toHaveAttribute("title");
    fireEvent.mouseOver(updatedCommentMarker!);
    expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
    fireEvent.mouseOver(title!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue(
        "Make the hero headline shorter",
      );
      expect(screen.getByTestId("html-dom-comment-add")).toBeDisabled();
    });
    fireEvent.mouseOut(title!, {
      relatedTarget: frame.contentDocument?.body,
    });
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
    });

    const bodyCopy = frame.contentDocument?.querySelector("p");
    expect(bodyCopy).not.toBeNull();
    mockElementRect(bodyCopy!, {
      height: 28,
      left: 48,
      top: 96,
      width: 180,
    });
    fireEvent.click(bodyCopy!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue("");
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(0);
    });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the body copy warmer",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(2);
    });
    expect(
      screen.getByTestId("html-dom-toolbar-comments-count"),
    ).toHaveTextContent("2");

    const bodyCommentMarker = Array.from(
      frame.contentDocument?.querySelectorAll<HTMLElement>(
        "[data-testid='html-dom-comment-marker']",
      ) ?? [],
    ).find((marker) => {
      return marker.textContent?.includes("Make the body copy warmer");
    });
    expect(bodyCommentMarker).toBeDefined();
    fireEvent.click(
      bodyCommentMarker!.querySelector<HTMLElement>(
        "[data-testid='html-dom-comment-delete']",
      )!,
    );
    await waitFor(() => {
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(1);
      expect(
        screen.getByTestId("html-dom-toolbar-comments-count"),
      ).toHaveTextContent("1");
    });

    fireEvent.click(bodyCopy!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue("");
    });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the body copy warmer",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(2);
    });

    mockElementRect(frame, {
      height: 640,
      left: 0,
      top: 0,
      width: 960,
    });
    mockElementRect(frame.parentElement!, {
      height: 720,
      left: 0,
      top: 0,
      width: 960,
    });
    fireEvent.click(title!);
    await waitFor(() => {
      const visibleMarkers = frame.contentDocument?.querySelectorAll(
        "[data-testid='html-dom-comment-marker']",
      );
      expect(visibleMarkers).toHaveLength(1);
      expect(
        visibleMarkers?.[0]?.querySelector(
          "[data-testid='html-dom-comment-tag']",
        ),
      ).toHaveTextContent("Make the hero headline shorter");
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue(
        "Make the hero headline shorter",
      );
      expect(
        screen.getByTestId("html-dom-comment-textarea"),
      ).not.toHaveAttribute("readonly");
    });
    const editedPopover = screen.getByTestId("html-dom-comment-popover");
    const initialEditedPopoverTop = Number.parseFloat(editedPopover.style.top);
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: 72,
      width: 32,
    });
    fireEvent.scroll(frame.contentDocument!);
    await waitFor(() => {
      expect(Number.parseFloat(editedPopover.style.top)).toBeGreaterThan(
        initialEditedPopoverTop,
      );
    });
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: -80,
      width: 32,
    });
    fireEvent.scroll(frame.contentDocument!);
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
      expect(title).not.toHaveAttribute(HTML_DOM_EDIT_SELECTED_ATTR);
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(1);
      expect(
        frame.contentDocument?.querySelector(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveTextContent("Make the body copy warmer");
    });
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: 24,
      width: 32,
    });
    fireEvent.click(title!);
    await waitFor(() => {
      expect(
        screen.getByTestId("html-dom-comment-textarea"),
      ).not.toHaveAttribute("readonly");
    });
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-popover")).toBeNull();
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(2);
    });

    click(screen.getByTestId("html-dom-toolbar-comments"));
    const commentsList = await screen.findByTestId("html-dom-comments-list");
    expect(within(commentsList).queryByText("Comment 1")).toBeNull();
    const heroListItem = within(commentsList).getByText(
      "Make the hero headline shorter",
    );
    expect(heroListItem).toBeInTheDocument();
    expect(
      within(commentsList).getByText("Make the body copy warmer"),
    ).toBeInTheDocument();
    const listDeleteButtons =
      within(commentsList).getAllByLabelText("Delete comment");
    expect(listDeleteButtons).toHaveLength(2);
    expect(listDeleteButtons[0]).toHaveClass("opacity-0");
    expect(listDeleteButtons[0]).toHaveClass("group-hover/comment:opacity-100");

    fireEvent.click(heroListItem);
    await waitFor(() => {
      expect(title).toHaveAttribute(HTML_DOM_EDIT_SELECTED_ATTR, "true");
      expect(title).toHaveAttribute("data-vm0-html-comment-flash", "true");
    });
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: -80,
      width: 32,
    });
    fireEvent.scroll(frame.contentDocument!);
    await waitFor(() => {
      const heroCommentMarker = Array.from(
        frame.contentDocument?.querySelectorAll<HTMLElement>(
          "[data-testid='html-dom-comment-marker']",
        ) ?? [],
      ).find((marker) => {
        return marker.textContent?.includes("Make the hero headline shorter");
      });
      expect(heroCommentMarker).toBeUndefined();
    });
    mockElementRect(title!, {
      height: 32,
      left: 284,
      top: 24,
      width: 32,
    });
    fireEvent.scroll(frame.contentDocument!);
    await waitFor(() => {
      const heroCommentMarker = Array.from(
        frame.contentDocument?.querySelectorAll<HTMLElement>(
          "[data-testid='html-dom-comment-marker']",
        ) ?? [],
      ).find((marker) => {
        return marker.textContent?.includes("Make the hero headline shorter");
      });
      expect(heroCommentMarker).toBeDefined();
    });

    listDeleteButtons[1]!.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        within(commentsList).queryByText("Make the body copy warmer"),
      ).toBeNull();
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(1);
      expect(
        screen.getByTestId("html-dom-toolbar-comments-count"),
      ).toHaveTextContent("1");
    });

    click(screen.getByTestId("html-dom-toolbar-comments"));
    fireEvent.click(bodyCopy!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue("");
    });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the body copy warmer",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(
        frame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(2);
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("html-dom-comment-toolbar"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "srcdoc",
        expect.stringContaining("Launch sooner"),
      );
      expect(screen.getByTestId("html-dom-draft-toolbar")).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-draft-discard")).toBeEnabled();
      expect(screen.getByTestId("html-dom-draft-publish")).toBeEnabled();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Preview draft");
      expect(within(sidebar).queryByLabelText("Open in new tab")).toBeNull();
      expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Download artifact")).toBeNull();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("html-dom-draft-discard"));
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-draft-toolbar")).toBeNull();
      expect(
        screen.queryByTestId("artifact-sidebar-body-html"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-comment-toolbar"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Editing");
      expect(
        within(sidebar).getByTestId("artifact-sidebar-exit-html-edit"),
      ).toHaveAttribute("aria-label", "Exit editing");
      expect(within(sidebar).queryByLabelText("Open in new tab")).toBeNull();
      expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Download artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Edit page")).toBeNull();
    });
    const restoredEditFrame = screen.getByTestId(
      "html-dom-comment-frame",
    ) as HTMLIFrameElement;
    await waitFor(() => {
      expect(restoredEditFrame.contentDocument?.body.textContent).toContain(
        "Launch faster",
      );
      expect(restoredEditFrame.contentDocument?.body.textContent).not.toContain(
        "Launch sooner",
      );
    });
  });

  it("saves an HTML edit snapshot when a comment draft is generated", async () => {
    const htmlUrl = "https://save-on-send.sites.vm7.io";
    const draftHtml =
      "<!doctype html><html><body><main><h1>Launch sooner</h1></main></body></html>";
    const savedBodies: string[] = [];
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(
        `<!doctype html><html><head><title>Save on send</title></head><body><main><h1>Launch faster</h1></main></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-save-on-send",
            files: [
              artifactFile(htmlUrl, {
                artifactKind: "hosted-site",
                filename: "save-on-send.html",
              }),
            ],
          },
        ],
      });
    });
    context.mocks.api(zeroHostContract.createHtmlEditDraft, ({ respond }) => {
      return respond(200, {
        kind: "html-edit-draft",
        version: 1,
        html: draftHtml,
      });
    });
    context.mocks.api(
      chatThreadArtifactsContract.upsertHtmlEditSnapshot,
      ({ body, params, respond }) => {
        expect(params.threadId).toBe(THREAD_ID);
        expect(body.url).toBe(htmlUrl);
        savedBodies.push(body.html);
        return respond(200, {
          artifactUrl: body.url,
          snapshotUrl:
            "https://cdn.vm7.io/artifacts/html-edit-drafts/save-on-send.html?v=1",
          updatedAt: "2026-03-10T00:06:00Z",
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-save-on-send",
          role: "assistant",
          content: `[Save on send](${htmlUrl})`,
          runId: "run-save-on-send",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.HtmlArtifactCommentEditing]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Open html preview for Save on send"));
    await waitFor(() => {
      expect(screen.getByLabelText("Edit page")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    fireEvent.click(frame.contentDocument!.querySelector("h1")!);

    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the headline shorter",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-draft-toolbar")).toBeInTheDocument();
      expect(savedBodies).toStrictEqual([draftHtml]);
    });
  });

  it("applies hosted-site HTML background and text color edits from the DOM popover", async () => {
    const htmlUrl = "https://color-launch-site.sites.vm7.io";
    let redeployedHtml: string | null = null;
    vi.stubGlobal(
      "EyeDropper",
      class {
        open(): Promise<{ readonly sRGBHex: string }> {
          return Promise.resolve({ sRGBHex: "#123456" });
        }
      },
    );

    setupHostedSiteArtifactPreview({
      filename: "color-launch-site.html",
      htmlUrl,
      label: "Color launch site",
      runId: "run-hosted-site-color",
    });
    context.mocks.api(zeroHostContract.redeployHtml, ({ body, respond }) => {
      expect(body.url).toBe(htmlUrl);
      expect(body.html).toContain("background-color");
      expect(body.html).toContain("color");
      expect(body.html).toMatch(/#FDE68A|rgb\(253, 230, 138\)/i);
      expect(body.html).toMatch(/#2563EB|rgb\(37, 99, 235\)/i);
      redeployedHtml = body.html;
      return respond(200, {
        siteId: "7c82da29-6280-4d65-b078-e233c8ad14bf",
        deploymentId: "dc8b4d42-5dc1-4769-ad8b-17bdf1ad035a",
        publicSlug: "color-launch-site",
        url: htmlUrl,
        status: "ready",
      });
    });

    click(
      await screen.findByLabelText("Open html preview for Color launch site"),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    const main = frame.contentDocument?.querySelector("main");
    expect(main).not.toBeNull();
    title!.style.color = "#ff0000";
    title!.style.backgroundColor = "rgb(0, 0, 0)";
    const originalElementsFromPoint =
      frame.contentDocument?.elementsFromPoint?.bind(frame.contentDocument);
    frame.contentDocument!.elementsFromPoint = () => {
      return [title!, main!, frame.contentDocument!.body];
    };
    fireEvent.click(main!, { clientX: 10, clientY: 10 });
    frame.contentDocument!.elementsFromPoint = originalElementsFromPoint!;

    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-color-controls")).toHaveClass(
        "grid-cols-2",
      );
      expect(screen.queryByTestId("html-dom-color-popover")).toBeNull();
      expect(
        screen
          .getByTestId("html-dom-color-controls")
          .compareDocumentPosition(
            screen.getByTestId("html-dom-comment-textarea"),
          ),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toHaveTextContent("#ff0000");
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toHaveTextContent("#000000");
    });
    click(screen.getByTestId("html-dom-color-control-backgroundColor"));
    expect(screen.getByTestId("html-dom-color-popover")).toBeInTheDocument();
    expect(
      screen.getByTestId("html-dom-floating-color-popover"),
    ).toContainElement(screen.getByTestId("html-dom-color-popover"));
    expect(screen.getByTestId("html-dom-comment-popover")).not.toContainElement(
      screen.getByTestId("html-dom-color-popover"),
    );
    const colorPopover = screen.getByTestId("html-dom-floating-color-popover");
    const initialColorPopoverLeft = Number.parseFloat(colorPopover.style.left);
    const initialColorPopoverTop = Number.parseFloat(colorPopover.style.top);
    fireEvent.pointerDown(
      screen.getByTestId("html-dom-color-popover-drag-handle"),
      {
        buttons: 1,
        clientX: 10,
        clientY: 10,
        pointerId: 3,
      },
    );
    fireEvent.pointerMove(
      screen.getByTestId("html-dom-color-popover-drag-handle"),
      {
        buttons: 1,
        clientX: 34,
        clientY: 28,
        pointerId: 3,
      },
    );
    await waitFor(() => {
      expect(Number.parseFloat(colorPopover.style.left)).toBe(
        initialColorPopoverLeft + 24,
      );
      expect(Number.parseFloat(colorPopover.style.top)).toBe(
        initialColorPopoverTop + 18,
      );
    });
    expect(screen.getByTestId("html-dom-color-field")).toBeInTheDocument();
    expect(screen.getByTestId("html-dom-color-hue-slider")).toBeInTheDocument();
    mockElementRect(screen.getByTestId("html-dom-color-field"), {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    fireEvent.pointerDown(screen.getByTestId("html-dom-color-field"), {
      buttons: 1,
      clientX: 100,
      clientY: 0,
      pointerId: 1,
    });
    await waitFor(() => {
      expect(title?.style.backgroundColor).toBe("#FF0000");
    });
    fireEvent.change(screen.getByLabelText("R"), { target: { value: "253" } });
    fireEvent.change(screen.getByLabelText("G"), { target: { value: "230" } });
    fireEvent.change(screen.getByLabelText("B"), { target: { value: "138" } });
    await waitFor(() => {
      expect(title?.style.backgroundColor).toBe("#FDE68A");
    });
    click(screen.getByTestId("html-dom-color-control-color"));
    await waitFor(() => {
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("html-dom-color-popover")).toBeInTheDocument();
    });
    mockElementRect(screen.getByTestId("html-dom-color-hue-slider"), {
      height: 28,
      left: 0,
      top: 0,
      width: 360,
    });
    fireEvent.pointerDown(screen.getByTestId("html-dom-color-hue-slider"), {
      buttons: 1,
      clientX: 180,
      clientY: 14,
      pointerId: 2,
    });
    await waitFor(() => {
      expect(title?.style.color).toBe("#00FFFF");
    });
    click(screen.getByTestId("html-dom-color-eyedropper"));
    await waitFor(() => {
      expect(title?.style.color).toBe("#123456");
    });
    fireEvent.change(screen.getByLabelText("R"), { target: { value: "37" } });
    fireEvent.change(screen.getByLabelText("G"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("B"), { target: { value: "235" } });

    await waitFor(() => {
      expect(title?.style.backgroundColor).toBe("#FDE68A");
      expect(title?.style.color).toBe("#2563EB");
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveValue("");
      expect(
        screen.queryByTestId("html-dom-toolbar-comments-count"),
      ).toBeNull();
      expect(screen.getByTestId("html-dom-toolbar-send")).toHaveTextContent(
        "Apply",
      );
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(redeployedHtml).not.toBeNull();
      expect(screen.queryByTestId("html-dom-comment-frame")).toBeNull();
    });
  });

  it("shows hosted-site HTML image controls for selected images", async () => {
    const htmlUrl = "https://image-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "image-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Image launch site</title></head>
        <body>
          <main>
            <h1>Launch faster</h1>
            <img src="/hero.png" alt="Hero" />
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Image launch site",
      runId: "run-hosted-site-image",
    });

    click(
      await screen.findByLabelText("Open html preview for Image launch site"),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("img")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    fireEvent.click(frame.contentDocument!.querySelector("img")!);

    await waitFor(() => {
      expect(
        screen.getByTestId("html-dom-comment-popover"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-image-tools")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-image-source-upload"),
      ).toHaveTextContent("Upload");
      expect(
        screen.getByTestId("html-dom-image-source-link"),
      ).toHaveTextContent("Link");
      expect(
        screen.getByTestId("html-dom-image-layout-cover"),
      ).toHaveTextContent("Cover");
      expect(
        screen.getByTestId("html-dom-image-layout-contain"),
      ).toHaveTextContent("Contain");
      expect(screen.getByTestId("html-dom-image-layout-fill")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByTestId("html-dom-image-upload-input")).toHaveAttribute(
        "accept",
        expect.stringContaining("image/png"),
      );
      expect(
        screen
          .getByTestId("html-dom-image-upload-input")
          .getAttribute("accept"),
      ).not.toContain("svg");
      expect(screen.getByTestId("html-dom-comment-textarea")).toHaveAttribute(
        "placeholder",
        "Ask Zero to adjust this image",
      );
      expect(screen.queryByTestId("html-dom-color-controls")).toBeNull();
    });
  });

  it("shows hosted-site HTML image controls when selecting image wrappers", async () => {
    const htmlUrl = "https://wrapped-image-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "wrapped-image-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Wrapped image launch site</title></head>
        <body>
          <main>
            <h1>Launch faster</h1>
            <figure>
              <a href="/hero">
                <img src="/hero.png" alt="Hero" />
              </a>
            </figure>
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Wrapped image launch site",
      runId: "run-hosted-site-wrapped-image",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Wrapped image launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("img")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
      expect(
        frame.contentDocument
          ?.querySelector("a")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });

    const link = frame.contentDocument!.querySelector("a")!;
    const image = frame.contentDocument!.querySelector("img")!;
    mockElementRect(image, {
      height: 80,
      left: 10,
      top: 20,
      width: 120,
    });
    fireEvent.mouseOver(image);

    await waitFor(() => {
      expect(
        within(frame.contentDocument!.body).getByTestId("html-dom-hover-box"),
      ).toHaveStyle({ border: "2px dashed rgba(37, 99, 235, 0.85)" });
    });

    let imageAnimationRunning = true;
    Object.defineProperty(image, "getAnimations", {
      configurable: true,
      value: () => {
        return imageAnimationRunning
          ? [
              {
                effect: {
                  getTiming: () => {
                    return { iterations: 1 };
                  },
                },
                playState: "running",
              },
            ]
          : [];
      },
    });

    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.getByTestId("html-dom-image-tools")).toBeInTheDocument();
      expect(screen.queryByTestId("html-dom-color-controls")).toBeNull();
      expect(image).toHaveAttribute(HTML_DOM_EDIT_SELECTED_ATTR, "true");
      expect(link).not.toHaveAttribute(HTML_DOM_EDIT_SELECTED_ATTR);
      expect(
        within(frame.contentDocument!.body).getByTestId(
          "html-dom-selected-box",
        ),
      ).toHaveStyle({ border: "2px solid rgb(37, 99, 235)" });
    });

    mockElementRect(image, {
      height: 80,
      left: 42,
      top: 36,
      width: 120,
    });

    await waitFor(() => {
      expect(
        within(frame.contentDocument!.body).getByTestId(
          "html-dom-selected-box",
        ),
      ).toHaveStyle({ left: "42px", top: "36px" });
    });

    mockElementRect(image, {
      height: 80,
      left: 64,
      top: 58,
      width: 120,
    });

    await waitFor(() => {
      expect(
        within(frame.contentDocument!.body).getByTestId(
          "html-dom-selected-box",
        ),
      ).toHaveStyle({ left: "64px", top: "58px" });
    });
    imageAnimationRunning = false;

    click(screen.getByTestId("html-dom-image-layout-cover"));

    await waitFor(() => {
      expect(image.style.objectFit).toBe("cover");
    });
  });

  it("uploads and applies a hosted-site HTML image replacement", async () => {
    const htmlUrl = "https://upload-image-launch-site.sites.vm7.io";
    const uploadedImageUrl =
      "https://cdn.vm7.io/artifacts/test/html-image/new-hero.png";
    let redeployedHtml: string | null = null;

    context.mocks.upload.success({
      id: "upload-html-hero-image",
      filename: "new-hero.png",
      contentType: "image/png",
      size: 2048,
      url: uploadedImageUrl,
    });
    setupHostedSiteArtifactPreview({
      filename: "upload-image-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Upload image launch site</title></head>
        <body>
          <main>
            <img src="/hero.png" srcset="/hero-small.png 1x, /hero-large.png 2x" sizes="100vw" alt="Hero" />
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Upload image launch site",
      runId: "run-hosted-site-upload-image",
    });
    context.mocks.api(zeroHostContract.redeployHtml, ({ body, respond }) => {
      expect(body.url).toBe(htmlUrl);
      expect(body.html).toContain(uploadedImageUrl);
      expect(body.html).not.toContain("srcset=");
      expect(body.html).not.toContain("sizes=");
      redeployedHtml = body.html;
      return respond(200, {
        siteId: "7c82da29-6280-4d65-b078-e233c8ad14bf",
        deploymentId: "dc8b4d42-5dc1-4769-ad8b-17bdf1ad035a",
        publicSlug: "upload-image-launch-site",
        url: htmlUrl,
        status: "ready",
      });
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Upload image launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("img")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const image = frame.contentDocument!.querySelector("img")!;
    fireEvent.click(image);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-image-tools")).toBeInTheDocument();
    });

    const user = userEvent.setup({ delay: null });
    await user.upload(
      screen.getByTestId("html-dom-image-upload-input"),
      new File(["new image"], "new-hero.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(uploadedImageUrl);
      expect(image.hasAttribute("srcset")).toBeFalsy();
      expect(image.hasAttribute("sizes")).toBeFalsy();
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
      expect(screen.getByTestId("html-dom-toolbar-send")).toHaveTextContent(
        "Apply",
      );
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(redeployedHtml).not.toBeNull();
      expect(screen.queryByTestId("html-dom-comment-frame")).toBeNull();
    });
  });

  it("replaces a hosted-site HTML image with a URL", async () => {
    const htmlUrl = "https://link-image-launch-site.sites.vm7.io";
    const linkedImageUrl = "https://images.example.com/replacement.png";

    setupHostedSiteArtifactPreview({
      filename: "link-image-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Link image launch site</title></head>
        <body>
          <main>
            <img src="/hero.png" alt="Hero" />
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Link image launch site",
      runId: "run-hosted-site-link-image",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Link image launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("img")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const image = frame.contentDocument!.querySelector("img")!;
    fireEvent.click(image);
    click(await screen.findByTestId("html-dom-image-source-link"));

    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-image-link-input"),
      linkedImageUrl,
    );
    click(screen.getByTestId("html-dom-image-link-submit"));

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(linkedImageUrl);
      expect(screen.queryByTestId("html-dom-image-link-form")).toBeNull();
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    });
  });

  it("applies hosted-site HTML image layout edits from the DOM popover", async () => {
    const htmlUrl = "https://layout-image-launch-site.sites.vm7.io";
    let redeployedHtml: string | null = null;

    setupHostedSiteArtifactPreview({
      filename: "layout-image-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Layout image launch site</title></head>
        <body>
          <main>
            <img src="/hero.png" alt="Hero" />
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Layout image launch site",
      runId: "run-hosted-site-layout-image",
    });
    context.mocks.api(zeroHostContract.redeployHtml, ({ body, respond }) => {
      expect(body.url).toBe(htmlUrl);
      expect(body.html).toContain("object-fit: cover");
      redeployedHtml = body.html;
      return respond(200, {
        siteId: "7c82da29-6280-4d65-b078-e233c8ad14bf",
        deploymentId: "dc8b4d42-5dc1-4769-ad8b-17bdf1ad035a",
        publicSlug: "layout-image-launch-site",
        url: htmlUrl,
        status: "ready",
      });
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Layout image launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("img")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const image = frame.contentDocument!.querySelector("img")!;
    fireEvent.click(image);
    click(await screen.findByTestId("html-dom-image-layout-cover"));

    await waitFor(() => {
      expect(image.style.objectFit).toBe("cover");
      expect(screen.getByTestId("html-dom-toolbar-send")).toHaveTextContent(
        "Apply",
      );
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(redeployedHtml).not.toBeNull();
      expect(screen.queryByTestId("html-dom-comment-frame")).toBeNull();
    });
  });

  it("shows hosted-site HTML color controls for text inputs and textareas", async () => {
    const htmlUrl = "https://form-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "form-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Form launch site</title></head>
        <body>
          <main>
            <input type="text" value="Launch faster" />
            <textarea>Ship the first version today.</textarea>
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Form launch site",
      runId: "run-hosted-site-form",
    });

    click(
      await screen.findByLabelText("Open html preview for Form launch site"),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("input")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
      expect(
        frame.contentDocument
          ?.querySelector("textarea")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });

    fireEvent.click(frame.contentDocument!.querySelector("input")!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-color-controls")).toHaveClass(
        "grid-cols-2",
      );
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toBeInTheDocument();
    });

    fireEvent.click(frame.contentDocument!.querySelector("textarea")!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toBeInTheDocument();
    });
  });

  it("shows hosted-site HTML color controls for semantic, select, and SVG text elements", async () => {
    const htmlUrl = "https://styleable-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "styleable-launch-site.html",
      html: `<!doctype html>
      <html>
        <head><title>Styleable launch site</title></head>
        <body>
          <main>
            <figure>
              <figcaption>Launch metrics</figcaption>
            </figure>
            <div class="text-card">
              <h2 style="color: #111827;">Nested title</h2>
            </div>
            <select>
              <option>Weekly plan</option>
            </select>
            <svg viewBox="0 0 200 40" width="200" height="40">
              <text x="0" y="24" style="fill: #ff0000;">SVG label</text>
            </svg>
          </main>
        </body>
      </html>`,
      htmlUrl,
      label: "Styleable launch site",
      runId: "run-hosted-site-styleable",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Styleable launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("figure")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
      expect(
        frame.contentDocument
          ?.querySelector(".text-card")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
      expect(
        frame.contentDocument
          ?.querySelector("select")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
      expect(
        frame.contentDocument
          ?.querySelector("text")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });

    fireEvent.click(frame.contentDocument!.querySelector("figure")!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toBeInTheDocument();
    });

    fireEvent.click(frame.contentDocument!.querySelector("select")!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toBeInTheDocument();
    });

    const textCard = frame.contentDocument!.querySelector(".text-card");
    const nestedTitle = frame.contentDocument!.querySelector("h2");
    expect(textCard).not.toBeNull();
    expect(nestedTitle).not.toBeNull();
    fireEvent.click(textCard!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-backgroundColor"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("html-dom-color-control-color"));
    fireEvent.change(screen.getByLabelText("R"), { target: { value: "37" } });
    fireEvent.change(screen.getByLabelText("G"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("B"), { target: { value: "235" } });
    await waitFor(() => {
      expect(nestedTitle?.style.color).toBe("#2563EB");
    });

    const svgText = frame.contentDocument!.querySelector("text");
    expect(svgText).not.toBeNull();
    fireEvent.click(svgText!);
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-color-controls")).toBeInTheDocument();
      expect(
        screen.getByTestId("html-dom-color-control-color"),
      ).toHaveTextContent("#ff0000");
      expect(
        screen.queryByTestId("html-dom-color-control-backgroundColor"),
      ).toBeNull();
    });

    click(screen.getByTestId("html-dom-color-control-color"));
    fireEvent.change(screen.getByLabelText("R"), { target: { value: "37" } });
    fireEvent.change(screen.getByLabelText("G"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("B"), { target: { value: "235" } });
    await waitFor(() => {
      expect(svgText?.style.getPropertyValue("fill")).toBe("#2563EB");
    });
  });

  it("does not enter hosted-site HTML edit mode from URL params when the feature is off", async () => {
    const htmlUrl = "https://feature-off-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      featureSwitches: {
        [FeatureSwitchKey.HtmlArtifactCommentEditing]: false,
      },
      filename: "feature-off-launch-site.html",
      htmlUrl,
      label: "Feature off launch site",
      path: `/chats/${THREAD_ID}?artifact=${encodeURIComponent(
        htmlUrl,
      )}&artifact-html-edit=1`,
      runId: "run-hosted-site-feature-off",
    });

    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-frame")).toBeNull();
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        expect.stringContaining(htmlUrl),
      );
      expect(
        within(sidebar).queryByTestId("artifact-sidebar-html-edit-status"),
      ).toBeNull();
      expect(within(sidebar).queryByLabelText("Edit page")).toBeNull();
    });
  });

  it("uploads a large hosted-site HTML snapshot before creating an edit draft", async () => {
    const htmlUrl = "https://large-launch-site.sites.vm7.io";
    const snapshotUrl =
      "https://cdn.vm7.io/artifacts/test/html-edit/large-snapshot.html";
    const longCopy = "Long launch copy ".repeat(40_000);
    let snapshotUploaded = false;

    context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
      expect(new URL(request.url).searchParams.get("url")).toBe(htmlUrl);
      return new Response(
        `<!doctype html>
        <html>
          <head><title>Large launch site</title></head>
          <body>
            <main>
              <h1>Launch faster</h1>
              <p>${longCopy}</p>
            </main>
          </body>
        </html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    context.mocks.http.post(
      "*/api/zero/uploads/html-dom-edit-snapshot",
      async ({ request }) => {
        const body = (await request.json()) as { readonly html: string };
        expect(body.html).toContain("Launch faster");
        expect(new TextEncoder().encode(body.html).byteLength).toBeGreaterThan(
          500_000,
        );
        snapshotUploaded = true;
        return Response.json({
          id: "html-edit-large-snapshot",
          filename: "vm0-html-edit.html",
          contentType: "text/html",
          size: body.html.length,
          url: snapshotUrl,
        });
      },
    );
    context.mocks.api(
      zeroHostContract.createHtmlEditDraft,
      ({ body, respond }) => {
        expect(snapshotUploaded).toBeTruthy();
        expect(body).toStrictEqual({
          htmlSnapshotUrl: snapshotUrl,
          comments: [
            {
              id: expect.any(String),
              targetNodeIds: [expect.any(String)],
              comment: "Make the hero headline shorter",
            },
          ],
        });
        return respond(200, {
          kind: "html-edit-draft",
          version: 1,
          html: "<!doctype html><html><body><main><h1>Launch sooner</h1><p>Short copy.</p></main></body></html>",
        });
      },
    );
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-hosted-site-large",
            files: [
              artifactFile(htmlUrl, {
                artifactKind: "hosted-site",
                filename: "large-launch-site.html",
              }),
            ],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-hosted-site-large-artifact",
          role: "assistant",
          content: `[Large launch site](${htmlUrl})`,
          runId: "run-hosted-site-large",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.HtmlArtifactCommentEditing]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await screen.findByLabelText("Open html preview for Large launch site"),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    fireEvent.click(title!);

    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the hero headline shorter",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    click(await screen.findByTestId("html-dom-toolbar-send"));

    await waitFor(() => {
      expect(snapshotUploaded).toBeTruthy();
      expect(
        screen.getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Preview draft");
    });
  });

  it("shows applying status while hosted-site HTML comments are being processed", async () => {
    const editGenerationStarted = context.mocks.deferred<void>();
    const editGenerationReady = context.mocks.deferred<void>();
    const publishStarted = context.mocks.deferred<void>();
    const publishReady = context.mocks.deferred<void>();
    const htmlUrl = "https://applying-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "applying-launch-site.html",
      htmlUrl,
      label: "Applying launch site",
      runId: "run-hosted-site-applying",
    });
    context.mocks.api(
      zeroHostContract.createHtmlEditDraft,
      async ({ respond }) => {
        editGenerationStarted.resolve();
        await editGenerationReady.promise;
        return respond(200, {
          kind: "html-edit-draft",
          version: 1,
          html: "<!doctype html><html><body><main><h1>Launch sooner</h1><p>Ship the first version today.</p></main></body></html>",
        });
      },
    );
    context.mocks.api(
      zeroHostContract.redeployHtml,
      async ({ body, respond }) => {
        expect(body).toStrictEqual({
          url: htmlUrl,
          html: "<!doctype html><html><body><main><h1>Launch sooner</h1><p>Ship the first version today.</p></main></body></html>",
        });
        publishStarted.resolve();
        await publishReady.promise;
        return respond(200, {
          siteId: "7c82da29-6280-4d65-b078-e233c8ad14bf",
          deploymentId: "dc8b4d42-5dc1-4769-ad8b-17bdf1ad035a",
          publicSlug: "applying-launch-site",
          url: htmlUrl,
          status: "ready",
        });
      },
    );

    click(
      await screen.findByLabelText(
        "Open html preview for Applying launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    fireEvent.click(title!);

    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the headline shorter",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await editGenerationStarted.promise;

    const sidebar = screen.getByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBe(frame);
      expect(
        screen.getByTestId("html-dom-comment-toolbar"),
      ).toBeInTheDocument();
      expect(frame).not.toHaveClass("pointer-events-none");
      expect(screen.getByTestId("html-dom-toolbar-comments")).toBeDisabled();
      expect(screen.getByTestId("html-dom-toolbar-discard")).toBeDisabled();
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeDisabled();
      expect(screen.queryByTestId("artifact-sidebar-body-html")).toBeNull();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Working");
      expect(screen.queryByTestId("html-dom-edit-preview-status")).toBeNull();
      expect(within(sidebar).queryByLabelText("Open in new tab")).toBeNull();
      expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
      expect(within(sidebar).queryByLabelText("Download artifact")).toBeNull();
      expect(
        within(sidebar).getByLabelText("Close artifact"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).queryByTestId("artifact-sidebar-exit-html-edit"),
      ).toBeNull();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
    });

    editGenerationReady.resolve();
    await waitFor(() => {
      expect(screen.queryByTestId("html-dom-comment-frame")).toBeNull();
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Preview draft");
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "srcdoc",
        expect.stringContaining("Launch sooner"),
      );
      expect(screen.getByTestId("html-dom-draft-toolbar")).toBeInTheDocument();
      expect(screen.getByTestId("html-dom-draft-discard")).toBeEnabled();
      expect(screen.getByTestId("html-dom-draft-publish")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-draft-publish"));
    await publishStarted.promise;
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-html-edit-status"),
      ).toHaveTextContent("Working");
      expect(screen.getByTestId("html-dom-draft-discard")).toBeDisabled();
      expect(screen.getByTestId("html-dom-draft-publish")).toBeDisabled();
    });

    publishReady.resolve();
    await waitFor(() => {
      const publishedFrame = screen.getByTestId("artifact-sidebar-body-html");
      expect(screen.queryByTestId("html-dom-draft-toolbar")).toBeNull();
      expect(
        within(sidebar).queryByTestId("artifact-sidebar-html-edit-status"),
      ).toBeNull();
      expect(publishedFrame).not.toHaveAttribute("srcdoc");
      expect(publishedFrame).toHaveAttribute(
        "src",
        expect.stringContaining(htmlUrl),
      );
      expect(
        within(sidebar).getByLabelText("Open in new tab"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Share artifact"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Download artifact"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByLabelText("Edit page")).toBeInTheDocument();
    });
  });

  it("keeps the hosted-site HTML draft when publish fails", async () => {
    const htmlUrl = "https://failed-publish-launch-site.sites.vm7.io";

    setupHostedSiteArtifactPreview({
      filename: "failed-publish-launch-site.html",
      htmlUrl,
      label: "Failed publish launch site",
      runId: "run-hosted-site-publish-failure",
    });
    context.mocks.api(zeroHostContract.createHtmlEditDraft, ({ respond }) => {
      return respond(200, {
        kind: "html-edit-draft",
        version: 1,
        html: "<!doctype html><html><body><main><h1>Launch sooner</h1><p>Ship the first version today.</p></main></body></html>",
      });
    });
    context.mocks.api(zeroHostContract.redeployHtml, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Publish failed",
        },
      });
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Failed publish launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    const frame = (await screen.findByTestId(
      "html-dom-comment-frame",
    )) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        frame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const title = frame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    fireEvent.click(title!);

    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the headline shorter",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-toolbar-send")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-toolbar-send"));
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "srcdoc",
        expect.stringContaining("Launch sooner"),
      );
      expect(screen.getByTestId("html-dom-draft-publish")).toBeEnabled();
    });

    click(screen.getByTestId("html-dom-draft-publish"));
    await waitFor(() => {
      expect(
        within(screen.getByTestId("artifact-sidebar")).getByTestId(
          "artifact-sidebar-html-edit-status",
        ),
      ).toHaveTextContent("Preview draft");
      expect(screen.getByTestId("html-dom-draft-discard")).toBeEnabled();
      expect(screen.getByTestId("html-dom-draft-publish")).toBeEnabled();
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "srcdoc",
        expect.stringContaining("Launch sooner"),
      );
    });
  });

  it("keeps direct hosted-site edit controls consistent while exiting and toggling fullscreen", async () => {
    setupHostedSiteArtifactPreview({
      filename: "direct-edit-launch-site.html",
      htmlUrl: "https://direct-edit-launch-site.sites.vm7.io",
      label: "Direct edit launch site",
      runId: "run-hosted-site-direct-edit",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Direct edit launch site",
      ),
    );
    click(await screen.findByLabelText("Edit page"));

    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expectHostedSiteEditingHeader({ fullscreen: false });
    });

    click(screen.getByTestId("artifact-sidebar-exit-html-edit"));

    await waitFor(() => {
      const sidebar = screen.getByTestId("artifact-sidebar");
      expect(
        screen.queryByTestId("html-dom-comment-frame"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByLabelText("Edit page")).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Close artifact"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("artifact-sidebar-edit-html"));
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expectHostedSiteEditingHeader({ fullscreen: false });
    });
    const editFrame = screen.getByTestId(
      "html-dom-comment-frame",
    ) as HTMLIFrameElement;
    await waitFor(() => {
      expect(
        editFrame.contentDocument
          ?.querySelector("h1")
          ?.hasAttribute(HTML_DOM_NODE_ID_ATTR),
      ).toBeTruthy();
    });
    const title = editFrame.contentDocument?.querySelector("h1");
    expect(title).not.toBeNull();
    fireEvent.click(title!);
    const user = userEvent.setup({ delay: null });
    await user.type(
      await screen.findByTestId("html-dom-comment-textarea"),
      "Make the title clearer",
    );
    fireEvent.keyDown(screen.getByTestId("html-dom-comment-textarea"), {
      key: "Enter",
    });
    await waitFor(() => {
      expect(
        editFrame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(1);
    });

    click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBe(editFrame);
      expect(
        editFrame.contentDocument?.querySelectorAll(
          "[data-testid='html-dom-comment-marker']",
        ),
      ).toHaveLength(1);
      expectHostedSiteEditingHeader({ fullscreen: true });
    });

    click(screen.getByTestId("artifact-sidebar-exit-html-edit"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("html-dom-comment-frame"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
      expect(screen.getByLabelText("Close artifact")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
      expect(screen.getByLabelText("Edit page")).toBeInTheDocument();
    });
  });

  it("keeps hosted-site edit controls consistent after opening split view first", async () => {
    setupHostedSiteArtifactPreview({
      filename: "split-edit-launch-site.html",
      htmlUrl: "https://split-edit-launch-site.sites.vm7.io",
      label: "Split edit launch site",
      runId: "run-hosted-site-split-edit",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Split edit launch site",
      ),
    );
    click(await screen.findByLabelText("Open in split view"));

    await waitFor(() => {
      const sidebar = screen.getByTestId("artifact-sidebar");
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByLabelText("Edit page")).toBeInTheDocument();
    });

    click(screen.getByTestId("artifact-sidebar-edit-html"));

    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expectHostedSiteEditingHeader({ fullscreen: false });
    });

    click(screen.getByTestId("artifact-sidebar-exit-html-edit"));

    await waitFor(() => {
      const sidebar = screen.getByTestId("artifact-sidebar");
      expect(
        screen.queryByTestId("html-dom-comment-frame"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Enter fullscreen"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByLabelText("Edit page")).toBeInTheDocument();
      expect(
        within(sidebar).getByLabelText("Close artifact"),
      ).toBeInTheDocument();
    });
  });

  it("keeps hosted-site edit fullscreen when fullscreen is entered before editing", async () => {
    setupHostedSiteArtifactPreview({
      filename: "fullscreen-edit-launch-site.html",
      htmlUrl: "https://fullscreen-edit-launch-site.sites.vm7.io",
      label: "Fullscreen edit launch site",
      runId: "run-hosted-site-fullscreen-edit",
    });

    click(
      await screen.findByLabelText(
        "Open html preview for Fullscreen edit launch site",
      ),
    );
    click(await screen.findByLabelText("Enter fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Edit page"));

    await waitFor(() => {
      expect(screen.getByTestId("html-dom-comment-frame")).toBeInTheDocument();
      expectHostedSiteEditingHeader({ fullscreen: true });
    });

    click(screen.getByTestId("artifact-sidebar-exit-html-edit"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("html-dom-comment-frame"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
      expect(screen.getByLabelText("Close artifact")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
      expect(screen.getByLabelText("Edit page")).toBeInTheDocument();
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
      chatMessages: [
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
      chatMessages: [
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
    expect(preview).toHaveClass(
      "aspect-[10/9]",
      "w-[200px]",
      "max-w-full",
      "cursor-pointer",
    );
    expect(
      within(preview).getByTestId("markdown-image-preview-loading"),
    ).toHaveClass("h-full", "w-full");

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("markdown-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
    expect(preview).toHaveClass(
      "aspect-[10/9]",
      "w-[200px]",
      "max-w-full",
      "cursor-pointer",
    );
    expect(image).toHaveClass("h-full", "w-full", "object-contain");
  });

  it("keeps markdown image preview dimensions stable while the image loads", async () => {
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image/kitten-1280x720.png";
    render(
      <StoreProvider value={context.store}>
        <Markdown source={`![1280x720](${imageUrl})`} mediaPreview />
      </StoreProvider>,
    );

    const image = await screen.findByAltText("1280x720");
    const preview = image.closest("button");
    if (!preview) {
      throw new Error("Markdown image preview button not found");
    }
    expect(preview).toHaveClass(
      "aspect-[10/9]",
      "w-[200px]",
      "max-w-full",
      "cursor-pointer",
    );
    expect(
      within(preview).getByTestId("markdown-image-preview-loading"),
    ).toHaveClass("h-full", "w-full");

    fireEvent.load(image);

    await waitFor(() => {
      expect(
        within(preview).queryByTestId("markdown-image-preview-loading"),
      ).not.toBeInTheDocument();
    });
    expect(preview).toHaveClass(
      "aspect-[10/9]",
      "w-[200px]",
      "max-w-full",
      "cursor-pointer",
    );
    expect(image).toHaveClass("h-full", "w-full", "object-contain");
  });

  it("renders user markdown images without preview controls", async () => {
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/user-markdown-image/kitten-1280x720.png";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-user-markdown-image",
          role: "user",
          content: `![1280x720](${imageUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const image = await screen.findByAltText("1280x720");
    expect(image).toHaveAttribute("src", imageUrl);
    expect(image.closest("button")).toBeNull();
    expect(image).not.toHaveAttribute("data-image-load-key");
    expect(
      screen.queryByTestId("markdown-image-preview-loading"),
    ).not.toBeInTheDocument();
  });

  it("opens markdown and text previews, shares a document link, and reports download failures", async () => {
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
      chatMessages: [
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
