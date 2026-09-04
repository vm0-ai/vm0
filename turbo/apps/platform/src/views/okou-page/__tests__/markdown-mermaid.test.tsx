import mermaid from "@okouai/mermaid-lite";
import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

warmMermaidParser();

function completedMessageRows(chat: MarkdownChatFixture, content: string) {
  return [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
}

function markdownFrameFor(element: Element): HTMLElement {
  const frame = element.closest<HTMLElement>(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected content inside a Markdown frame");
  }
  return frame;
}

function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

function diagramButtons(container: ParentNode = document.body): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((button) => {
    return button.getAttribute("aria-label") === "Expand diagram";
  });
}

async function openAppearanceSettings(): Promise<HTMLElement> {
  click(getButtonByName("Test User"));
  const settingsItem = await waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.trim() === "Settings";
    });
    if (!item) {
      throw new Error('Expected menu item named "Settings"');
    }
    return item;
  });
  click(settingsItem);
  return await screen.findByRole("dialog", { name: "Settings" });
}

test("A Mermaid diagram can move from chat into artifact split view", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "```mermaid",
    "flowchart TD",
    "  First --> Preview",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Reader->>Platform: Expand second",
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
  });

  const [inlineImages, expandActions] = await waitFor(() => {
    const images = screen.getAllByRole("img", { name: "Diagram" });
    const actions = diagramButtons();
    expect(images).toHaveLength(2);
    expect(actions).toHaveLength(2);
    return [images, actions] as const;
  });
  const firstExpand = expandActions[0];
  const secondExpand = expandActions[1];
  if (!firstExpand || !secondExpand) {
    throw new Error("Expected two diagram expand actions");
  }
  expect(firstExpand).toBeEnabled();
  expect(secondExpand).toBeEnabled();
  expect(inlineImages).toHaveLength(2);

  click(firstExpand);

  const dialog = await screen.findByRole("dialog", {
    name: "diagram.svg preview",
  });
  expect(getButtonByName("Open in split view", dialog)).toBeVisible();
  expect(
    queryAllByRoleFast("button", dialog).some((button) => {
      return button.getAttribute("aria-label") === "Share";
    }),
  ).toBeFalsy();

  const dialogRemoved = waitForElementToBeRemoved(dialog);
  click(getButtonByName("Open in split view", dialog));

  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(within(sidebar).getByText("diagram.svg")).toBeVisible();
  const firstSidebarImage = await within(sidebar).findByRole("img", {
    name: "diagram.svg",
  });
  const firstSidebarSource = firstSidebarImage.getAttribute("src");
  await dialogRemoved;

  click(secondExpand);

  await waitFor(() => {
    const currentImage = within(sidebar).getByRole("img", {
      name: "diagram.svg",
    });
    expect(currentImage.getAttribute("src")).not.toBe(firstSidebarSource);
  });
  expect(
    screen.queryByRole("dialog", { name: "diagram.svg preview" }),
  ).toBeNull();

  const sidebarRemoved = waitForElementToBeRemoved(sidebar);
  click(getButtonByName("Close artifact", sidebar));

  await sidebarRemoved;
  expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
  expect(screen.getAllByText("Diagram source")).toHaveLength(2);
});

test("Completed Mermaid diagrams remain accessible and inspectable", async () => {
  const chat = createMarkdownChatFixture(context);
  const renderGate = context.mocks.deferred<void>();
  const renderDiagram = mermaid.render.bind(mermaid);
  vi.spyOn(mermaid, "render").mockImplementation(async (...args) => {
    await renderGate.promise;
    return await renderDiagram(...args);
  });
  const diagramSource = ["flowchart TD", "  Accessible --> Diagram"].join("\n");
  const source = [
    "```mermaid",
    diagramSource,
    "```",
    "",
    "```mermaid",
    diagramSource,
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
  });

  const pendingActions = await waitFor(() => {
    const actions = diagramButtons();
    expect(actions).toHaveLength(2);
    return actions;
  });
  for (const pendingAction of pendingActions) {
    expect(pendingAction).toBeDisabled();
  }
  expect(screen.getAllByText("Diagram source")).toHaveLength(2);
  const sourceBlocks = Array.from(
    document.querySelectorAll<HTMLElement>(".mermaid-diagram-source code"),
  );
  expect(sourceBlocks).toHaveLength(2);
  expect(
    sourceBlocks.every((sourceBlock) => {
      return sourceBlock.textContent === diagramSource;
    }),
  ).toBeTruthy();

  renderGate.resolve();

  await waitFor(() => {
    expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
    expect(diagramButtons()).toHaveLength(2);
    expect(
      diagramButtons().every((button) => {
        return !button.hasAttribute("disabled");
      }),
    ).toBeTruthy();
  });
});

test("Mermaid diagrams follow the selected appearance", async () => {
  const chat = createMarkdownChatFixture(context);
  const diagramSource = ["flowchart TD", "  Theme --> Content"].join("\n");
  const source = ["```mermaid", diagramSource, "```"].join("\n");
  const rows = completedMessageRows(chat, source);
  context.mocks.data.userPreferences({ theme: "light" });
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
  });

  const lightDiagram = await screen.findByRole("img", { name: "Diagram" });
  const lightSource = lightDiagram.getAttribute("src");
  expect(markdownFrameFor(lightDiagram)).toHaveAttribute(
    "data-color-mode",
    "light",
  );

  const settings = await openAppearanceSettings();
  click(getButtonByName("Dark", settings));

  await waitFor(() => {
    expect(document.documentElement).toHaveClass("dark");
  });
  const darkSettingsRemoved = waitForElementToBeRemoved(settings);
  click(getButtonByName("Close", settings));
  await darkSettingsRemoved;

  const darkDiagram = await waitFor(() => {
    const current = screen.getByRole("img", { name: "Diagram" });
    expect(markdownFrameFor(current)).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    expect(current.getAttribute("src")).not.toBe(lightSource);
    return current;
  });
  const darkSourceUrl = darkDiagram.getAttribute("src");
  const darkSource = document.querySelector(".mermaid-diagram-source code");
  if (!darkSource) {
    throw new Error("Expected the diagram source to remain inspectable");
  }
  expect(darkSource.textContent).toBe(diagramSource);

  const lightSettings = await openAppearanceSettings();
  click(getButtonByName("Light", lightSettings));

  await waitFor(() => {
    expect(document.documentElement).not.toHaveClass("dark");
  });
  const lightSettingsRemoved = waitForElementToBeRemoved(lightSettings);
  click(getButtonByName("Close", lightSettings));
  await lightSettingsRemoved;

  await waitFor(() => {
    const current = screen.getByRole("img", { name: "Diagram" });
    expect(markdownFrameFor(current)).toHaveAttribute(
      "data-color-mode",
      "light",
    );
    expect(current.getAttribute("src")).not.toBe(darkSourceUrl);
  });
  const lightSourceBlock = document.querySelector(
    ".mermaid-diagram-source code",
  );
  if (!lightSourceBlock) {
    throw new Error("Expected the diagram source after returning to light");
  }
  expect(lightSourceBlock.textContent).toBe(diagramSource);
});

test("A streaming Mermaid diagram stays readable until complete", async () => {
  const chat = createMarkdownChatFixture(context);
  const streamingEventId = "markdown-streaming-event";
  const partialSource = [
    "```mermaid",
    "flowchart TD",
    "  Completed --> Independent",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Reader->>Platform: Partial",
  ].join("\n");
  const completeSource = `${partialSource}\n\`\`\``;
  const rows = [
    chat.outputMessage(partialSource, {
      id: streamingEventId,
      seqId: 1,
      runEventId: "markdown-streaming-message",
    }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
  });

  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeVisible();
  const partialCode = document.querySelector("code.language-mermaid");
  expect(partialCode).not.toBeNull();
  expect(partialCode).toHaveTextContent("sequenceDiagram");
  expect(partialCode).toHaveTextContent("Reader->>Platform: Partial");
  expect(partialCode).toBeVisible();
  expect(diagramButtons()).toHaveLength(1);

  rows[0] = chat.outputMessage(completeSource, {
    id: streamingEventId,
    seqId: 2,
    sequenceNumber: 1,
    runEventId: "markdown-streaming-message",
  });
  rows.push(
    chat.runCompleted({
      seqId: 3,
      sequenceNumber: 2,
    }),
  );
  context.mocks.ably.trigger(chat.realtimeTopic);

  await waitFor(() => {
    expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
    expect(document.querySelector("code.language-mermaid")).toBeNull();
    expect(diagramButtons()).toHaveLength(2);
  });
});
