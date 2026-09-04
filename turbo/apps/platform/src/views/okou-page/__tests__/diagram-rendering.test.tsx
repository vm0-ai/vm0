import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
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
