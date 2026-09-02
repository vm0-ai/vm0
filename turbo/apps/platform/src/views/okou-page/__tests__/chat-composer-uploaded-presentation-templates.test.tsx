import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "../../../lib/platform-template-items.ts";
import {
  buttonContainingText,
  expectTextBefore,
  linkByText,
  trackTemplatePreviewImagePreloads,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  TEMPLATE_FEATURES,
  THREAD_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
  openTemplatePicker,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

const UPLOADED_TEMPLATE_ID = "82000000-0000-4000-a000-000000000001";
const UPDATED_TEMPLATE_ID = "82000000-0000-4000-a000-000000000002";
const REMOVED_TEMPLATE_ID = "82000000-0000-4000-a000-000000000003";
const OTHER_THREAD_ID = "82000000-0000-4000-a000-000000000004";
const UPLOADED_TEMPLATE_NOW_MS = 1_785_542_400_000;

function importedTemplateCard(templateId: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(
    `[data-imported-presentation-template="${templateId}"]`,
  );
  if (!card) {
    throw new Error(`Imported template card ${templateId} not found`);
  }
  return card;
}

function importedTemplateMedia(templateId: string): HTMLElement {
  const media = importedTemplateCard(templateId).querySelector<HTMLElement>(
    "[data-imported-presentation-template-media]",
  );
  if (!media) {
    throw new Error(`Imported template media ${templateId} not found`);
  }
  return media;
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button named "${name}" not found`);
  }
  return button;
}

function presentationGrid(): HTMLElement {
  const grid = document.querySelector<HTMLElement>(
    "[data-presentation-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Presentation template grid not found");
  }
  return grid;
}

function firstBuiltInTitle(): string {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Built-in presentation template not found");
  }
  return template.title;
}

function sentTemplate(capture: ReturnType<typeof mockTemplateChat>) {
  const message = capture.sentMessages[0];
  if (!message) {
    throw new Error("No presentation message was sent");
  }
  return templatePart(message).template;
}

test("Use an uploaded presentation template", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  const capture = mockTemplateChat();
  const uploaded = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Quarterly Board Review",
    pageCount: 3,
  });
  mockPresentationTemplateLibrary([uploaded]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.vm0.ai",
    featureSwitches: TEMPLATE_FEATURES,
  });

  const picker = await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(uploaded.title)).toBeVisible();
  });
  expectTextBefore(uploaded.title, firstBuiltInTitle());

  const media = importedTemplateMedia(uploaded.id);
  Object.defineProperty(media, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(0, 0, 300, 169);
    },
  });
  await user.hover(media);
  await waitFor(() => {
    const image = media.querySelector<HTMLImageElement>("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("slide-1"));
  });
  fireEvent.mouseMove(media, { clientX: 299 });
  await waitFor(() => {
    const image = media.querySelector<HTMLImageElement>("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("slide-3"));
  });

  click(buttonNamed(`Preview ${uploaded.title} at current slide`, media));
  const detail = await screen.findByRole("group", {
    name: `${uploaded.title} slide preview`,
  });
  expect(buttonNamed("Preview slide 3", picker)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(detail).toBeVisible();
  click(buttonNamed(`Select template ${uploaded.title}`));
  await sendComposerMessage(user, "Use this deck for the launch review");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(sentTemplate(capture)).toMatchObject({
    type: "presentation",
    selection: {
      templateId: formatUserPresentationTemplateId(uploaded.id),
    },
  });
});

test("Keep uploaded-template browsing stable during changes", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  mockTemplateChat();
  const viewed = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Operating Plan",
    pageCount: 3,
    visibility: "public",
    canManage: true,
  });
  const remaining = createUploadedTemplate({
    id: UPDATED_TEMPLATE_ID,
    title: "Customer Research",
  });
  const removed = createUploadedTemplate({
    id: REMOVED_TEMPLATE_ID,
    title: "Retired Deck",
  });
  const library = mockPresentationTemplateLibrary([viewed, remaining, removed]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: TEMPLATE_FEATURES,
  });

  const picker = await openTemplatePicker(user, "Presentation");
  const previewViewed = await waitFor(() => {
    return buttonNamed(`Preview ${viewed.title} at current slide`);
  });
  click(previewViewed);
  const detail = await screen.findByRole("group", {
    name: `${viewed.title} slide preview`,
  });
  click(buttonNamed("Preview slide 2", picker));
  const activeImage = within(detail).getByAltText(
    `${viewed.title} slide preview`,
  );
  const activeImageUrl = activeImage.getAttribute("src");
  expect(buttonNamed("Preview slide 2", picker)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const refreshedViewed = createUploadedTemplate({
    id: viewed.id,
    title: viewed.title,
    pageCount: 3,
    visibility: "private",
    canManage: true,
    updatedAt: "2026-08-01T00:02:00.000Z",
  });
  library.replace([refreshedViewed, remaining, removed]);
  context.mocks.ably.trigger(
    "presentationTemplatesChanged",
    refreshedViewed.id,
  );
  await waitFor(() => {
    expect(screen.getByText("Only you can see and use it")).toBeVisible();
  });
  expect(buttonNamed("Preview slide 2", picker)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    within(detail).getByAltText(`${viewed.title} slide preview`),
  ).toHaveAttribute("src", activeImageUrl);

  click(buttonContainingText("Template", screen.getByRole("dialog")));
  const grid = presentationGrid();
  Object.defineProperties(grid, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 360 },
  });
  fireEvent.scroll(grid);
  expect(screen.getByText(removed.title)).toBeVisible();

  library.replace([refreshedViewed, remaining]);
  context.mocks.ably.trigger("presentationTemplatesChanged", removed.id);
  await waitFor(() => {
    expect(screen.queryByText(removed.title)).not.toBeInTheDocument();
  });
  expect(grid.scrollTop).toBe(360);
  expectTextBefore(remaining.title, firstBuiltInTitle());
});

test("Keep workspace template availability current", async () => {
  mockNow(UPLOADED_TEMPLATE_NOW_MS, context.signal);
  const capture = mockTemplateChat();
  const existing = createUploadedTemplate({
    id: UPLOADED_TEMPLATE_ID,
    title: "Existing Workspace Deck",
    canManage: false,
  });
  const published = createUploadedTemplate({
    id: UPDATED_TEMPLATE_ID,
    title: "New Workspace Deck",
    canManage: false,
  });
  const library = mockPresentationTemplateLibrary([existing]);
  capture.lifecycle.setThreadList([
    {
      id: THREAD_ID,
      title: "First workspace chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    },
    {
      id: OTHER_THREAD_ID,
      title: "Second workspace chat",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T00:02:00.000Z",
      updatedAt: "2026-08-01T00:03:00.000Z",
    },
  ]);
  trackTemplatePreviewImagePreloads();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
    featureSwitches: TEMPLATE_FEATURES,
  });

  await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(existing.title)).toBeVisible();
  });
  await user.keyboard("{Escape}");
  const secondChat = await waitFor(() => {
    return linkByText("Second workspace chat");
  });
  click(secondChat);
  await waitFor(() => {
    expect(secondChat).toHaveAttribute("aria-current", "page");
  });

  library.replace([existing, published]);
  context.mocks.ably.triggerOnChannel(
    "org:org_default",
    "presentationTemplatesChanged",
    published.id,
  );
  await openTemplatePicker(user, "Presentation");
  await waitFor(() => {
    expect(screen.getByText(published.title)).toBeVisible();
    expect(
      screen.getByLabelText(`Select template ${published.title}`),
    ).toBeEnabled();
  });
  click(buttonNamed(`Preview ${published.title} at current slide`));
  await screen.findByRole("group", {
    name: `${published.title} slide preview`,
  });
  click(buttonContainingText("Template", screen.getByRole("dialog")));

  library.replace([existing]);
  context.mocks.ably.triggerOnChannel(
    "org:org_default",
    "presentationTemplatesChanged",
    published.id,
  );
  await waitFor(() => {
    expect(screen.queryByText(published.title)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(`Select template ${published.title}`),
    ).not.toBeInTheDocument();
  });
});
