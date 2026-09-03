import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type {
  ImageAnnotationMark,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { resolveApiBase } from "../../../signals/api-base.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { fillComposer, mockChatLifecycle } from "./chat-test-helpers.ts";
import { buildModelPolicy } from "./chat-composer-test-helpers.ts";
import { createMockAgentResponse } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000901";
const FILE_ID = "annotated-screenshot";
const ANNOTATED_FILE_ID = "annotated-screenshot-rendered";
const FILE_URL = "https://cdn.vm7.io/artifacts/test/drafts/billing-page.png";

function mockAgentChatPage(): void {
  // Without a policy the composer refuses to send at all, which would hide
  // whatever the annotation path does with the message.
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000921",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
    }),
  ]);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    updatedAt: "2026-03-10T00:00:00Z",
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, [
      createMockAgentResponse({
        agentId: AGENT_ID,
        displayName: "Annotation Agent",
        visibility: "public",
      }),
    ]);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      agentId: params.id,
      ownerId: "test-user-123",
      description: null,
      displayName: "Annotation Agent",
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
}

/**
 * Seeds the composer from a persisted draft. This is the entry point that
 * matters for the ownership model: the marks have to come back off the stored
 * draft, not off a rendered copy, and the file itself is untouched.
 */
interface SavedDraft {
  readonly userMessage: unknown;
  readonly attachments: unknown;
}

function mockDraftWithImage(
  marks: ImageAnnotationMark[] | null,
  savedDrafts: SavedDraft[] = [],
  // What the draft has stored for the attachment. A persisted attachment can
  // carry the canonical API address rather than a public one, and that address
  // only answers to an Authorization header.
  storedUrl: string = FILE_URL,
): void {
  // A restored attachment revalidates its file before a send can use it.
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, { url: FILE_URL });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    savedDrafts.push({
      userMessage: body.draftUserMessage,
      attachments: body.draftAttachments,
    });
    return respond(200, { ok: true });
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: FILE_ID,
            filenameSnapshot: "billing-page.png",
            contentType: "image/png",
            ...(marks
              ? {
                  annotatedFileId: ANNOTATED_FILE_ID,
                  annotations: { marks },
                }
              : {}),
          },
        ],
      },
      draftAttachments: [
        {
          id: FILE_ID,
          filename: "billing-page.png",
          contentType: "image/png",
          size: 4096,
          url: storedUrl,
        },
      ],
    });
  });
}

function boxMark(): ImageAnnotationMark {
  return {
    id: "mark-1",
    shape: "box",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    ink: "#5E6AD2",
    note: "Tighten this spacing",
  };
}

function setup(featureEnabled: boolean): void {
  detachedSetupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerImageAnnotation]: featureEnabled,
    },
  });
}

function attachMarksButton(): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Attach marks";
  });
  if (!button) {
    throw new Error("Attach marks button not found");
  }
  return button;
}

interface DragBox {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

/** jsdom reports a zero-sized box for every element, so the surface is given
 * one explicitly — the editor divides by it to normalize each point. */
async function sizedSurface(): Promise<HTMLElement> {
  const surface = await screen.findByTestId("image-annotation-surface");
  surface.getBoundingClientRect = () => {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => {
        return {};
      },
    };
  };
  return surface;
}

/** Drags a rectangle across the drawing surface. */
async function dragOnSurface(
  box: DragBox = { fromX: 40, fromY: 30, toX: 200, toY: 180 },
): Promise<void> {
  const surface = await screen.findByTestId("image-annotation-surface");
  // jsdom reports a zero-sized box for every element, so the surface is given
  // one explicitly — the editor divides by it to normalize each point.
  surface.getBoundingClientRect = () => {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => {
        return {};
      },
    };
  };
  fireEvent.pointerDown(surface, {
    clientX: box.fromX,
    clientY: box.fromY,
    pointerId: 1,
  });
  fireEvent.pointerMove(surface, {
    clientX: box.toX,
    clientY: box.toY,
    pointerId: 1,
  });
  fireEvent.pointerUp(surface, {
    clientX: box.toX,
    clientY: box.toY,
    pointerId: 1,
  });
}

/**
 * Serves the bytes of the image being annotated.
 *
 * Flattening reads the original over the network before it can draw on it, so
 * without this the marks are composited onto an image that was never fetched.
 * The stub `Image` alone cannot stand in for it: it reports `load` for any src,
 * including one the browser would have refused, which is how a read that fails
 * for every annotated screenshot still looked green here.
 */
function mockOriginalImageBytes(url: string = FILE_URL): { reads: number } {
  const counter = { reads: 0 };
  context.mocks.http.get(url, () => {
    counter.reads += 1;
    return new Response(new Blob(["original"], { type: "image/png" }), {
      headers: { "Content-Type": "image/png" },
    });
  });
  return counter;
}

function mockAnnotationRendering(): void {
  mockOriginalImageBytes();
  mockAnnotationCanvas();
}

function mockAnnotationCanvas(): void {
  context.mocks.browser.imageDimensions({ width: 800, height: 600 });
  const noop = () => {};
  const canvasContext = {
    arc: noop,
    arcTo: noop,
    beginPath: noop,
    closePath: noop,
    drawImage: noop,
    fill: noop,
    fillRect: noop,
    fillText: noop,
    lineTo: noop,
    measureText: () => {
      return { width: 80 } as TextMetrics;
    },
    moveTo: noop,
    restore: noop,
    roundRect: noop,
    save: noop,
    stroke: noop,
    strokeText: noop,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    contextId: string,
  ) => {
    return contextId === "2d" ? canvasContext : null;
  }) as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => {
      callback(new Blob(["annotated"], { type: "image/png" }));
    },
  );
}

function mockAnnotatedUploadSuccess(): void {
  context.mocks.upload.success({
    id: ANNOTATED_FILE_ID,
    filename: "billing-page.annotated.png",
    contentType: "image/png",
    size: 9,
    url: "https://cdn.vm7.io/artifacts/test/drafts/billing-page.annotated.png",
  });
}

function mockSuccessfulAnnotationUpload(): void {
  mockAnnotationRendering();
  mockAnnotatedUploadSuccess();
}

async function composerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

describe("composer image annotation", () => {
  it("sends one structured annotated file part", async () => {
    const user = userEvent.setup({ delay: null });
    const requests: {
      readonly prompt: string;
      readonly userMessage?: UserMessageDocument;
    }[] = [];
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt, userMessage }) => {
        requests.push({ prompt, ...(userMessage ? { userMessage } : {}) });
      },
    });
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    await fillComposer(await composerEditor(), "Fix the billing page");
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(requests.length).toBeGreaterThan(0);
    });
    expect(requests[0]?.prompt).toBe("Fix the billing page");
    expect(requests[0]?.userMessage?.parts).toContainEqual({
      type: "file",
      fileId: FILE_ID,
      filenameSnapshot: "billing-page.png",
      contentType: "image/png",
      annotatedFileId: ANNOTATED_FILE_ID,
      annotations: { marks: [boxMark()] },
    });
  });

  it("restores marks stored on the draft and shows the count on the chip", async () => {
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    await waitFor(() => {
      expect(
        screen.getByTestId("composer-attachment-mark-count"),
      ).toHaveTextContent("1");
    });
  });

  it("hides the annotate entry when the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage(null);

    setup(false);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);

    await screen.findByTestId("attachment-lightbox");
    expect(screen.queryByTestId("artifact-dialog-annotate")).toBeNull();
  });

  it("draws a mark, undoes it, and attaches the rest to the draft", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    const savedDrafts: SavedDraft[] = [];
    mockSuccessfulAnnotationUpload();
    mockDraftWithImage(null, savedDrafts);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));

    await screen.findByTestId("image-annotation-editor");
    await dragOnSurface();

    // The header count is the editor's own read of the draft annotation.
    await waitFor(() => {
      expect(screen.getByText("1 mark")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Undo"));
    await waitFor(() => {
      expect(screen.getByText("0 marks")).toBeInTheDocument();
    });

    await dragOnSurface();
    await waitFor(() => {
      expect(screen.getByText("1 mark")).toBeInTheDocument();
    });

    await user.click(attachMarksButton());

    // Committing closes the editor and leaves the count on the one chip —
    // annotating must never produce a second attachment.
    await waitFor(() => {
      expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
      expect(
        screen.getByTestId("composer-attachment-mark-count"),
      ).toHaveTextContent("1");
    });
    expect(
      screen.getAllByLabelText("Open image preview for billing-page.png"),
    ).toHaveLength(1);

    await waitFor(() => {
      expect(
        savedDrafts.some((saved) => {
          return JSON.stringify(saved.userMessage).includes(ANNOTATED_FILE_ID);
        }),
      ).toBeTruthy();
    });
    expect(savedDrafts).not.toContainEqual(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({ annotations: expect.anything() }),
        ]),
      }),
    );
  });

  /**
   * Flattening used to reach for the original with an
   * `<img crossOrigin="anonymous">`, which made it the only step in the feature
   * that needed the CDN's permission — the editor renders the very same URL as
   * a plain `<img>` and negotiates nothing. So the image the user had just
   * finished drawing on could still be refused here, and every annotated
   * screenshot failed on attach while the editor itself looked perfectly fine.
   * The read is a `fetch` now, so a refusal arrives with its status instead of a
   * bare `error` event, and the marks land on bytes this app actually holds.
   */
  it("attaches marks when the original image is only readable as bytes", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    const savedDrafts: SavedDraft[] = [];
    mockAnnotationCanvas();
    mockAnnotatedUploadSuccess();
    const original = mockOriginalImageBytes();
    mockDraftWithImage(null, savedDrafts);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await dragOnSurface();
    await user.click(attachMarksButton());

    await waitFor(() => {
      expect(
        savedDrafts.some((saved) => {
          return JSON.stringify(saved.userMessage).includes(ANNOTATED_FILE_ID);
        }),
      ).toBeTruthy();
    });
    // The bytes were actually read, rather than an image element reporting a
    // load for a src it never successfully fetched.
    expect(original.reads).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Try again/)).toBeNull();
  });

  /**
   * A persisted attachment's stored address is the canonical API route, which
   * answers only to an Authorization header — a bare `fetch` or `src` gets a
   * 401 from it. The editor never touches that address: it exchanges it for a
   * presigned object URL first. Flattening derived the URL a second way and
   * skipped the exchange, so the picture the user had just drawn on was
   * refused the moment they pressed attach.
   */
  it("flattens through the presigned url when the draft stored the api one", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    const savedDrafts: SavedDraft[] = [];
    mockAnnotationCanvas();
    mockAnnotatedUploadSuccess();
    const original = mockOriginalImageBytes();

    // Reading the canonical route directly is the regression: it is unreadable
    // without the header a `fetch` cannot attach.
    let canonicalReads = 0;
    context.mocks.http.get("*/api/web/download-file", () => {
      canonicalReads += 1;
      return new Response(null, { status: 401 });
    });
    mockDraftWithImage(
      null,
      savedDrafts,
      `${resolveApiBase()}/api/web/download-file?file_id=${FILE_ID}`,
    );

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await dragOnSurface();
    await user.click(attachMarksButton());

    await waitFor(() => {
      expect(
        savedDrafts.some((saved) => {
          return JSON.stringify(saved.userMessage).includes(ANNOTATED_FILE_ID);
        }),
      ).toBeTruthy();
    });
    expect(original.reads).toBeGreaterThan(0);
    expect(canonicalReads).toBe(0);
  });

  it("offers a retry when the original image cannot be read", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockAnnotationCanvas();
    context.mocks.upload.success({
      id: ANNOTATED_FILE_ID,
      filename: "billing-page.annotated.png",
      contentType: "image/png",
      size: 9,
      url: "https://cdn.vm7.io/artifacts/test/drafts/billing-page.annotated.png",
    });
    // The object is there, but this viewer is refused it.
    context.mocks.http.get(FILE_URL, () => {
      return new Response(null, { status: 403 });
    });
    mockDraftWithImage(null);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await dragOnSurface();
    await user.click(attachMarksButton());

    // The mark survives on the chip and the failure is recoverable in place,
    // rather than the editor closing over a silently dropped annotation.
    const retry = await screen.findByLabelText(
      "Failed to upload billing-page.png. Try again.",
    );
    expect(retry).toBeInTheDocument();
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
  });

  it("blocks send while the confirmed derivative is uploading", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockAnnotationRendering();
    context.mocks.upload.pending({
      id: ANNOTATED_FILE_ID,
      filename: "billing-page.annotated.png",
      contentType: "image/png",
      size: 9,
      url: "https://cdn.vm7.io/artifacts/test/drafts/billing-page.annotated.png",
    });
    mockDraftWithImage(null);

    setup(true);
    await fillComposer(await composerEditor(), "Fix the billing page");
    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await dragOnSurface();
    await user.click(attachMarksButton());

    await waitFor(() => {
      expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });
  });

  it("draws stored marks in the read-only viewer, not just in the editor", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);

    // The viewer shows the image as stored, so the marks have to be drawn over
    // it — otherwise reopening an annotated image looks like the marks vanished.
    await screen.findByTestId("attachment-lightbox");
    await waitFor(() => {
      expect(screen.getByTestId("annotation-mark-layer")).toBeInTheDocument();
    });
  });

  /**
   * The numbers are what the user's notes refer to, in the editor and in the
   * text the agent receives. Deleting one must not slide the rest down; the
   * hole it leaves is what the next mark fills.
   */
  it("reuses a deleted mark's number instead of renumbering the rest", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage(null);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    await dragOnSurface({ fromX: 20, fromY: 20, toX: 80, toY: 70 });
    await dragOnSurface({ fromX: 120, fromY: 20, toX: 180, toY: 70 });
    await dragOnSurface({ fromX: 220, fromY: 20, toX: 280, toY: 70 });
    await waitFor(() => {
      expect(screen.getByText("3 marks")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("annotation-mark-2"));
    await user.click(await screen.findByLabelText("Remove mark"));
    await waitFor(() => {
      expect(screen.getByText("2 marks")).toBeInTheDocument();
    });

    // The survivor keeps its own number rather than sliding into the gap.
    expect(screen.getByTestId("annotation-mark-3")).toBeInTheDocument();
    expect(screen.queryByTestId("annotation-mark-2")).toBeNull();

    await dragOnSurface({ fromX: 20, fromY: 150, toX: 80, toY: 200 });
    await waitFor(() => {
      expect(screen.getByTestId("annotation-mark-2")).toBeInTheDocument();
    });
    expect(screen.getByTestId("annotation-mark-3")).toBeInTheDocument();
    expect(screen.queryByTestId("annotation-mark-4")).toBeNull();

    // With no hole left, numbering carries on from the end.
    await dragOnSurface({ fromX: 120, fromY: 150, toX: 180, toY: 200 });
    await waitFor(() => {
      expect(screen.getByTestId("annotation-mark-4")).toBeInTheDocument();
    });
  });

  /**
   * The note is the instruction; the flattened image is what the model looks
   * at. A sentence that only exists in the prompt leaves the model matching
   * words to regions by position, so it has to be printed on the image too.
   */
  it("prints a mark's note and opens it for editing when clicked", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage(null);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await dragOnSurface({ fromX: 40, fromY: 30, toX: 200, toY: 120 });

    // Nothing is printed until there is something to print.
    expect(screen.queryByTestId(/^annotation-note-label-/u)).toBeNull();

    await user.click(await screen.findByTestId("annotation-mark-1"));
    await user.type(
      await screen.findByPlaceholderText("Say what should change here"),
      "Tighten this spacing",
    );

    const label = await waitFor(() => {
      const found = document.querySelector(
        '[data-testid^="annotation-note-label-"]',
      );
      if (!(found instanceof HTMLElement)) {
        throw new Error("Note label not drawn on the image");
      }
      return found;
    });
    expect(label).toHaveTextContent("Tighten this spacing");

    // The label is words, so clicking it edits those words. It used to start a
    // drag instead, and a note could be moved anywhere on the image.
    await user.click(await screen.findByTestId("annotation-mark-1"));
    await user.click(label);
    const field = await screen.findByPlaceholderText(
      "Say what should change here",
    );
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Tighten this spacing");

    // Opening the note does not hand over the mark's resize grips: it was
    // clicked to be rewritten, not to reshape the region it describes.
    expect(screen.queryByTestId("annotation-handle-tl")).toBeNull();

    // The swatches still recolour the mark the popover has open, whichever way
    // it was opened — the popover is one control, not two.
    await user.click(await screen.findByLabelText("Ink #EC70A5"));
    await waitFor(() => {
      expect(screen.getByTestId("annotation-mark-1").style.border).toContain(
        "#EC70A5",
      );
    });

    // And a press on the label leaves it exactly where the placement put it.
    const before = { top: label.style.top, left: label.style.left };
    fireEvent.pointerDown(label, { clientX: 60, clientY: 140, pointerId: 2 });
    fireEvent.pointerMove(
      await screen.findByTestId("image-annotation-surface"),
      { clientX: 320, clientY: 280, pointerId: 2 },
    );
    fireEvent.pointerUp(label, { clientX: 320, clientY: 280, pointerId: 2 });
    expect(label.style.top).toBe(before.top);
    expect(label.style.left).toBe(before.left);
  });

  /**
   * Escape backs out one layer at a time. With a note open the shortcut read
   * the MARK selection, which is null in that state, so Escape took the
   * "nothing is selected" branch and closed the whole editor — discarding every
   * mark drawn so far, from the path this feature makes the primary one.
   */
  it("keeps the editor open when Escape leaves a note being edited", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    await user.click(await screen.findByTestId("annotation-note-label-mark-1"));
    const field = await screen.findByPlaceholderText(
      "Say what should change here",
    );
    expect(field).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    // The note closes and the session survives with its marks.
    await waitFor(() => {
      expect(screen.queryByTestId("annotation-note-popover")).toBeNull();
    });
    expect(screen.getByTestId("image-annotation-editor")).toBeInTheDocument();
    expect(screen.getByTestId("annotation-mark-1")).toBeInTheDocument();
  });

  /**
   * A note printed past the bottom edge is cropped out of the flattened image
   * and nobody finds out, because the text still travels in the prompt. A mark
   * with no room under it has to put its note above itself instead.
   */
  it("keeps the note of a bottom-edge mark inside the image", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage(null);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    // A box hugging the bottom of a 400x300 surface.
    await dragOnSurface({ fromX: 40, fromY: 250, toX: 200, toY: 296 });
    await user.click(await screen.findByTestId("annotation-mark-1"));
    await user.type(
      await screen.findByPlaceholderText("Say what should change here"),
      "This row is cut off",
    );

    const label = await waitFor(() => {
      const found = screen.getByTestId(/^annotation-note-label-/u);
      return found;
    });
    const top = Number.parseFloat(label.style.top);
    const left = Number.parseFloat(label.style.left);
    const width = Number.parseFloat(label.style.width);
    expect(top).toBeLessThan(100);
    expect(top).toBeGreaterThanOrEqual(0);
    // Placed above the mark rather than under it, and still on the image.
    expect(top).toBeLessThan(83);
    expect(left + width).toBeLessThanOrEqual(100);
  });

  /**
   * A corner grip changes both dimensions; an edge grip changes one. Dragging
   * the top edge sideways must not slide the box across the image.
   */
  it("resizes height alone from the top edge", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    await user.click(
      await screen.findByLabelText("Open image preview for billing-page.png"),
    );
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await user.click(await screen.findByTestId("annotation-mark-1"));

    const surface = await sizedSurface();
    const mark = screen.getByTestId("annotation-mark-1");
    const before = mark.style.left;

    fireEvent.pointerDown(screen.getByTestId("annotation-handle-t"), {
      clientX: 100,
      clientY: 30,
      pointerId: 3,
    });
    fireEvent.pointerMove(surface, { clientX: 160, clientY: 60, pointerId: 3 });
    fireEvent.pointerUp(surface, { clientX: 160, clientY: 60, pointerId: 3 });

    await waitFor(() => {
      expect(screen.getByTestId("annotation-mark-1").style.top).not.toBe("10%");
    });
    // The horizontal drag went nowhere, which is the whole point of an edge.
    expect(screen.getByTestId("annotation-mark-1").style.left).toBe(before);
  });

  it("deletes the selected mark", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    await waitFor(() => {
      expect(screen.getByText("1 mark")).toBeInTheDocument();
    });

    // Selecting a mark opens its note beside it; the note owns the delete.
    await user.click(screen.getByTestId("annotation-mark-1"));
    await user.click(await screen.findByLabelText("Remove mark"));

    await waitFor(() => {
      expect(screen.getByText("0 marks")).toBeInTheDocument();
    });
  });

  it("selects a mark by clicking it and offers resize handles", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    // There is no select mode any more: the mark itself is the handle.
    expect(screen.queryByLabelText("Select")).toBeNull();

    await user.click(screen.getByTestId("annotation-mark-1"));
    await waitFor(() => {
      expect(screen.getByTestId("annotation-handle-tl")).toBeInTheDocument();
      expect(screen.getByTestId("annotation-handle-br")).toBeInTheDocument();
    });
  });

  it("removes the selected mark with the Delete key", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage([boxMark()]);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");
    await user.click(screen.getByTestId("annotation-mark-1"));

    // The note must not hold focus for a non-text mark, or Delete lands in the
    // field instead of removing the mark.
    fireEvent.keyDown(document, { key: "Delete" });

    await waitFor(() => {
      expect(screen.getByText("0 marks")).toBeInTheDocument();
    });
  });

  /**
   * Opening the editor is not an edit. Attaching has to stay unavailable until
   * there is something to attach, and it has to come back once there is.
   */
  it("keeps an opened-but-untouched image unannotated", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    mockAgentChatPage();
    mockDraftWithImage(null);

    setup(true);

    const chip = await screen.findByLabelText(
      "Open image preview for billing-page.png",
    );
    await user.click(chip);
    await user.click(await screen.findByTestId("artifact-dialog-annotate"));
    await screen.findByTestId("image-annotation-editor");

    expect(attachMarksButton()).toBeDisabled();

    await dragOnSurface();
    await waitFor(() => {
      expect(attachMarksButton()).toBeEnabled();
    });

    // Undoing back to the start leaves nothing to attach again.
    await user.click(screen.getByLabelText("Undo"));
    await waitFor(() => {
      expect(attachMarksButton()).toBeDisabled();
    });

    await user.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    });
    expect(screen.queryByTestId("composer-attachment-mark-count")).toBeNull();
  });
});
