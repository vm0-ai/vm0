import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { ImageAnnotationMark } from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { createMockAgentResponse } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000901";
const FILE_ID = "annotated-screenshot";
const FILE_URL = "https://cdn.vm7.io/artifacts/test/drafts/billing-page.png";

function mockAgentChatPage(): void {
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
function mockDraftWithImage(marks: ImageAnnotationMark[] | null): void {
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

/** Drags a rectangle across the drawing surface. */
async function dragOnSurface(): Promise<void> {
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
  fireEvent.pointerDown(surface, { clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: 200, clientY: 180, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: 200, clientY: 180, pointerId: 1 });
}

describe("composer image annotation", () => {
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
    mockDraftWithImage(null);

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
    await user.click(attachMarksButton());

    await waitFor(() => {
      expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    });
    expect(screen.queryByTestId("composer-attachment-mark-count")).toBeNull();
  });
});
