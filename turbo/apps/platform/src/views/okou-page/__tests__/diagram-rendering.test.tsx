import mermaid from "@okouai/mermaid-lite";
import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
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

test("A diagram keeps the correct appearance during a theme change", async () => {
  const chat = createMarkdownChatFixture(context);
  const lightRender = context.mocks.deferred<void>();
  const diagramFiles: File[] = [];
  let objectUrlIndex = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    objectUrlIndex += 1;
    if (blob instanceof File && blob.type === "image/svg+xml") {
      diagramFiles.push(blob);
    }
    return `blob:mermaid-theme-${objectUrlIndex}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    return undefined;
  });

  let activeMermaidTheme = "unknown";
  const initializeMermaid = mermaid.initialize.bind(mermaid);
  vi.spyOn(mermaid, "initialize").mockImplementation((config) => {
    activeMermaidTheme = config.theme ?? "unknown";
    initializeMermaid(config);
  });
  let renderIndex = 0;
  vi.spyOn(mermaid, "render").mockImplementation(async (_id, code) => {
    const currentRenderIndex = renderIndex;
    renderIndex += 1;
    if (currentRenderIndex === 0) {
      await lightRender.promise;
    }
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" data-mermaid-theme="${activeMermaidTheme}"><text>${code}</text></svg>`,
    };
  });
  const source = ["```mermaid", "flowchart TD", "  Light --> Dark", "```"].join(
    "\n",
  );
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

  await waitFor(() => {
    const actions = diagramButtons();
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (!action) {
      throw new Error("Expected a pending diagram action");
    }
    expect(action).toBeDisabled();
  });

  const settings = await openAppearanceSettings();
  click(getButtonByName("Dark", settings));

  await waitFor(() => {
    expect(document.documentElement).toHaveClass("dark");
  });
  lightRender.resolve();

  await waitFor(() => {
    expect(diagramFiles).toHaveLength(2);
  });
  const lightFile = diagramFiles[0];
  const darkFile = diagramFiles[1];
  if (!lightFile || !darkFile) {
    throw new Error("Expected one rendered diagram file for each theme");
  }
  const lightMarkup = await lightFile.text();
  const darkMarkup = await darkFile.text();
  expect(lightMarkup).toContain('data-mermaid-theme="redux"');
  expect(darkMarkup).toContain('data-mermaid-theme="redux-dark"');

  const settingsRemoved = waitForElementToBeRemoved(settings);
  click(getButtonByName("Close", settings));
  await settingsRemoved;
  const visibleDiagram = await screen.findByRole("img", { name: "Diagram" });
  expect(visibleDiagram).toHaveAttribute("src", "blob:mermaid-theme-2");
});

test("Sequence diagrams render in chat", async () => {
  const chat = createMarkdownChatFixture(context);
  const sequenceSource = [
    "sequenceDiagram",
    "  participant Reader",
    "  participant Platform",
    "  Reader->>Platform: Show sequence",
    "  Platform-->>Reader: Render diagram",
  ].join("\n");
  const source = ["```mermaid", sequenceSource, "```"].join("\n");
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

  const diagram = await screen.findByRole("img", { name: "Diagram" });
  expect(diagram).toBeVisible();
  expect(getButtonByName("Expand diagram")).toBeEnabled();
});
