import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { ImageAnnotationMark } from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
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
      defaultProviderType: "vm0",
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
  readonly annotation?: unknown;
}

function mockDraftWithImage(
  marks: ImageAnnotationMark[] | null,
  savedDraftAttachments: (readonly SavedDraft[] | null)[] = [],
): void {
  // A restored attachment revalidates its file before a send can use it.
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, { url: FILE_URL });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    savedDraftAttachments.push(body.draftAttachments ?? null);
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
          },
        ],
      },
      draftAttachments: [
        {
          id: FILE_ID,
          filename: "billing-page.png",
          contentType: "image/png",
          size: 4096,
          url: FILE_URL,
          ...(marks ? { annotation: { marks } } : {}),
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
 * jsdom fetches nothing, so a real `Image` neither loads nor errors and the
 * flatten waits out its whole deadline. Failing the decode immediately is the
 * same branch a broken CDN takes in the browser, and it is the branch the send
 * has to survive.
 */
function failImageDecodes(): void {
  vi.stubGlobal(
    "Image",
    class {
      crossOrigin = "";
      #onError: (() => void) | null = null;
      addEventListener(type: string, handler: () => void) {
        if (type === "error") {
          this.#onError = handler;
        }
      }
      set src(_value: string) {
        this.#onError?.();
      }
    },
  );
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
  /**
   * The mark notes only pay off if the agent receives them, and every other
   * test here stops at the moment the marks are attached. This one crosses the
   * send boundary: whatever the user wrote on the image has to arrive in the
   * outgoing prompt, anchored to the file it was drawn on.
   */
  it("sends the mark notes to the agent alongside the message", async () => {
    const user = userEvent.setup({ delay: null });
    const sentPrompts: string[] = [];
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    });
    mockAgentChatPage();
    failImageDecodes();
    mockDraftWithImage([boxMark()]);

    setup(true);

    await fillComposer(await composerEditor(), "Fix the billing page");
    await user.click(screen.getByLabelText("Send"));

    // The image stub fails the flattened copy immediately. The send falls back
    // to the original image, but the notes still have to arrive.
    await waitFor(() => {
      expect(sentPrompts.length).toBeGreaterThan(0);
    });
    expect(sentPrompts[0]).toContain("Fix the billing page");
    expect(sentPrompts[0]).toContain("Marks on billing-page.png");
    expect(sentPrompts[0]).toContain("Tighten this spacing");
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
    const savedDraftAttachments: (readonly SavedDraft[] | null)[] = [];
    mockDraftWithImage(null, savedDraftAttachments);

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

    // Attaching has to reach the stored draft. It used to write the signal and
    // stop, so anything that reloaded the draft took the marks with it.
    await waitFor(() => {
      expect(
        savedDraftAttachments.some((saved) => {
          return saved?.some((attachment) => {
            return attachment.annotation !== undefined;
          });
        }),
      ).toBeTruthy();
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
  it("prints a mark's note on the image and lets it be placed", async () => {
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

    // Selecting the note hands over its own grip, not the mark's.
    fireEvent.pointerDown(label, { clientX: 60, clientY: 140, pointerId: 2 });
    const widthHandle = await screen.findByTestId(
      "annotation-note-width-handle",
    );
    expect(widthHandle).toBeInTheDocument();
    expect(screen.queryByTestId("annotation-handle-tl")).toBeNull();
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
