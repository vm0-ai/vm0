import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  boxAnnotation,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();

async function openAnnotationEditor(filename: string): Promise<HTMLElement> {
  click(await findNamedButton(`Open image preview for ${filename}`));
  click(await findNamedButton("Annotate"));
  const surface = await screen.findByTestId("image-annotation-surface");
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 500,
    width: 800,
    height: 500,
    toJSON: () => {
      return {};
    },
  });
  Object.defineProperty(surface, "setPointerCapture", {
    configurable: true,
    value: vi.fn<(pointerId: number) => void>(),
  });
  return surface;
}

test("A selected annotation mark can be resized directly", async () => {
  const image = draftAttachment("resizable-layout.png", {
    annotatedFileId: "draft-resizable-layout-annotated",
    annotations: boxAnnotation([{ id: "resizable-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("resizable-layout.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  expect(screen.getByTestId("annotation-handle-tl")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-tr")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-bl")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-br")).toBeVisible();
});

test("A confirmed annotation blocks sending while its image uploads", async () => {
  const image = draftAttachment("billing-page.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.pending({
    id: "draft-billing-page-annotated",
    filename: "billing-page.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://cdn.vm7.io/artifacts/tests/chat-attachments/billing-page.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await fillComposer(
    await screen.findByRole("textbox", { name: "Message" }),
    "Fix the billing page",
  );
  await expect(screen.findByLabelText("Send")).resolves.toBeEnabled();

  const surface = await openAnnotationEditor("billing-page.png");
  fireEvent.pointerDown(surface, {
    clientX: 40,
    clientY: 30,
    pointerId: 1,
  });
  fireEvent.pointerMove(surface, {
    clientX: 200,
    clientY: 180,
    pointerId: 1,
  });
  fireEvent.pointerUp(surface, {
    clientX: 200,
    clientY: 180,
    pointerId: 1,
  });
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeDisabled();
  });
});
