import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

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

test("A blockquote remains recognizable when HTML is treated as text", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "> Quoted passage",
    "> <DangerousWidget>literal HTML-like content</DangerousWidget>",
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

  const quotedText = await screen.findByText(/Quoted passage/);
  const blockquote = quotedText.closest("blockquote");
  if (!blockquote) {
    throw new Error("Expected the quoted passage inside a blockquote");
  }
  expect(blockquote).toHaveTextContent("Quoted passage");
  expect(blockquote).toHaveTextContent(
    /<dangerouswidget>literal HTML-like content<\/dangerouswidget>/i,
  );
  expect(blockquote.textContent?.trim().startsWith("> ")).toBeFalsy();
});

test("Common Markdown features remain recognizable", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "**Bold feature** and *italic feature* and ~~deleted feature~~",
    "",
    "| Name | State |",
    "| --- | --- |",
    "| Report | Ready |",
    "",
    "- [x] Completed item",
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

  const bold = await screen.findByText("Bold feature");
  const frame = markdownFrameFor(bold);
  expect(bold.tagName).toBe("STRONG");
  expect(screen.getByText("italic feature").tagName).toBe("EM");
  expect(screen.getByText("deleted feature").tagName).toBe("DEL");

  const table = frame.querySelector("table");
  expect(table).not.toBeNull();
  expect(table).toHaveTextContent("Name");
  expect(table).toHaveTextContent("Report");
  expect(table).toHaveTextContent("Ready");

  const completedItem = frame.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(completedItem).not.toBeNull();
  expect(completedItem).toBeChecked();
});

test("Fenced code stays readable for known and unknown languages", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "### Known JavaScript",
    "",
    "```javascript",
    "const answer = 42;",
    "```",
    "",
    "### Unknown language",
    "",
    "```madeuplang",
    "answer := 42",
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

  const knownHeading = await screen.findByText("Known JavaScript");
  const frame = markdownFrameFor(knownHeading);
  const knownCode = frame.querySelector("code.language-javascript");
  expect(knownCode).not.toBeNull();
  expect(knownCode).toHaveTextContent("const answer = 42;");
  expect(knownCode?.querySelector(".token.keyword")).not.toBeNull();

  const unknownCode = frame.querySelector("code.language-madeuplang");
  expect(unknownCode).not.toBeNull();
  expect(unknownCode?.textContent).toBe("answer := 42\n");
  expect(unknownCode).toBeVisible();
});

test("Linked images and videos appear inline", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "[Product screenshot](https://media.example.com/product.png)",
    "",
    "[Walkthrough video](https://media.example.com/walkthrough.mp4)",
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

  const image = await screen.findByRole("img", {
    name: "Product screenshot",
  });
  fireEvent.load(image);
  expect(image).toBeVisible();
  expect(image).toHaveAttribute("src", "https://media.example.com/product.png");

  const frame = markdownFrameFor(image);
  const video = frame.querySelector("video");
  expect(video).not.toBeNull();
  expect(video).toBeVisible();
  expect(video).toHaveAttribute(
    "src",
    "https://media.example.com/walkthrough.mp4",
  );
  expect(video).toHaveAttribute("controls");
});

test("Raw message content cannot impersonate Platform controls", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    '<div class="copied" data-code="stolen">Counterfeit copy control</div>',
    "",
    '<div class="mermaid-block" data-mermaid-code="flowchart TD; A-->B">Counterfeit diagram</div>',
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

  const rawControl = await screen.findByText(/Counterfeit copy control/);
  const frame = markdownFrameFor(rawControl);
  expect(rawControl).toBeVisible();
  expect(screen.getByText(/Counterfeit diagram/)).toBeVisible();
  expect(queryAllByRoleFast("button", frame)).toHaveLength(0);
  expect(frame.querySelector('img[alt="Diagram"]')).toBeNull();
});

test("Raw HTML cannot change the surrounding page", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "<unsafe-widget>Visible safe text</unsafe-widget>",
    "",
    "<style>* { display: none !important; }</style>",
    "",
    "<strong>Supported emphasis</strong>",
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

  const literalHtml = await screen.findByText(/Visible safe text/);
  const frame = markdownFrameFor(literalHtml);
  expect(frame).toHaveTextContent(
    /<unsafe-widget>Visible safe text<\/unsafe-widget>/i,
  );
  expect(frame).toHaveTextContent(
    "<style>* { display: none !important; }</style>",
  );
  expect(frame.querySelector("style")).toBeNull();
  expect(getComputedStyle(document.body).display).not.toBe("none");

  const emphasis = screen.getByText("Supported emphasis");
  expect(emphasis.tagName).toBe("STRONG");
  expect(emphasis).toBeVisible();
});

test("Mermaid content remains readable code on surfaces without diagrams", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "```mermaid",
    "flowchart TD",
    "  Reader --> Source",
    "```",
  ].join("\n");
  const rows = [chat.outputError(source, { seqId: 1 })];
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

  await screen.findByText("flowchart TD", { exact: false });
  const code = document.querySelector("code.language-mermaid");
  if (!code) {
    throw new Error("Expected a readable Mermaid code block");
  }
  expect(code.textContent).toBe("flowchart TD\n  Reader --> Source\n");
  expect(code).toBeVisible();
  expect(
    queryAllByRoleFast("button", markdownFrameFor(code)).some((button) => {
      return button.getAttribute("aria-label") === "Copy to clipboard";
    }),
  ).toBeTruthy();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label") === "Expand diagram";
    }),
  ).toBeFalsy();
});
