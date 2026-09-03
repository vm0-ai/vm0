import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  boxAnnotation,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  privateAttachmentUrl,
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

function drawBox(surface: HTMLElement): void {
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

test("A user can click an annotation note, edit it, and close only the note", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("annotated-plan.png", {
    annotatedFileId: "draft-annotated-plan-rendered",
    annotations: boxAnnotation([
      {
        id: "editable-note",
        ordinal: 1,
        note: "Move the total higher",
      },
    ]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("annotated-plan.png");
  await user.click(screen.getByTestId("annotation-note-label-editable-note"));

  const note = await screen.findByPlaceholderText(
    "Say what should change here",
  );
  await waitFor(() => {
    expect(note).toHaveFocus();
  });
  await fill(note, "Align the total with the heading");
  await user.keyboard("{Escape}");

  expect(screen.queryByTestId("annotation-note-popover")).toBeNull();
  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
  expect(
    screen.getByTestId("annotation-note-label-editable-note"),
  ).toHaveTextContent("Align the total with the heading");
});

test("A confirmed annotation blocks sending while its image uploads", async () => {
  const image = draftAttachment("billing-page.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
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
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeDisabled();
  });
});

test("Attach marks after resolving and reading the original image", async () => {
  const fileId = "a0000000-0000-4000-a000-000000000091";
  const resolvedUrl = "https://private-files.example/annotated-billing.png";
  const image = draftAttachment("annotated-billing.png", {
    id: fileId,
    url: privateAttachmentUrl(fileId),
  });
  let imageReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  mockPrivateUrlSequence(context, { [fileId]: [resolvedUrl] });
  context.mocks.http.get(resolvedUrl, () => {
    imageReads += 1;
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000092",
    filename: "annotated-billing.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/annotated-billing.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("annotated-billing.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(imageReads).toBe(1);
  expect(
    screen.queryByLabelText(
      "Failed to upload annotated-billing.png. Try again.",
    ),
  ).toBeNull();
});

test("Retry attaching marks when the original image cannot be read", async () => {
  const image = draftAttachment("retry-billing.png");
  let imageReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    imageReads += 1;
    if (imageReads === 1) {
      return new HttpResponse(null, { status: 403, statusText: "Forbidden" });
    }
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000093",
    filename: "retry-billing.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/retry-billing.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("retry-billing.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  const retry = await findNamedButton(
    "Failed to upload retry-billing.png. Try again.",
  );
  expect(
    screen.getByTestId("composer-attachment-mark-count"),
  ).toHaveTextContent("1");
  expect(screen.getByLabelText("Send")).toBeDisabled();

  click(retry);

  await waitFor(() => {
    expect(
      screen.queryByLabelText("Failed to upload retry-billing.png. Try again."),
    ).toBeNull();
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(imageReads).toBe(2);
});
