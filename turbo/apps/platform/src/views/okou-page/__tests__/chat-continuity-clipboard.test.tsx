import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

interface ClipboardAttachment {
  readonly id: string | null;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

interface RichClipboardPayload {
  readonly text: string;
  readonly attachments: readonly ClipboardAttachment[];
  readonly userMessage?: {
    readonly version: 1;
    readonly parts: readonly (
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "chat_thread";
          readonly threadId: string;
          readonly titleSnapshot: string;
        }
    )[];
  };
}

function richClipboard(
  payload: RichClipboardPayload,
  plainText = payload.text,
): DataTransfer {
  const data = new DataTransfer();
  const encoded = encodeURIComponent(JSON.stringify(payload));
  data.setData(
    "text/html",
    `<div data-vm0-chat-message="${encoded}">${payload.text}</div>`,
  );
  data.setData("text/plain", plainText);
  return data;
}

function placeCaret(
  composer: HTMLElement,
  textNodeContent: string,
  offset: number,
): void {
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== textNodeContent) {
    node = walker.nextNode();
  }
  if (!node) {
    throw new Error(`Expected composer text node ${textNodeContent}`);
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
}

function placeCaretAtEnd(composer: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
}

test("Paste copied chat text and attachments safely", async () => {
  const thread = continuityThread(14, 1, "Clipboard restoration");
  const available = continuityAttachment(14, 1, "available-copy.txt");
  const missing = continuityAttachment(14, 2, "missing-copy.txt");
  const localized = continuityAttachment(14, 3, "locale-copy.txt");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 14,
    threads: [thread],
    resolveAttachment(fileId) {
      return fileId === missing.id ? "missing" : "available";
    },
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "Before after");
  placeCaret(composer, "Before after", 7);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text: "First copied line\nSecond copied line",
      attachments: [available],
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "First copied line\nSecond copied line" },
        ],
      },
    }),
  });

  await waitFor(() => {
    expect(composer).toHaveTextContent("First copied line");
    expect(composer).toHaveTextContent("Second copied line");
    expect(fastButton("Remove available-copy.txt")).toBeVisible();
  });
  const firstPasteText = composer.textContent ?? "";
  expect(firstPasteText.indexOf("Before")).toBeLessThan(
    firstPasteText.indexOf("First copied line"),
  );
  expect(firstPasteText.indexOf("Second copied line")).toBeLessThan(
    firstPasteText.lastIndexOf("after"),
  );

  placeCaretAtEnd(composer);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text: " Text kept from an inaccessible copy",
      attachments: [missing],
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: " Text kept from an inaccessible copy" }],
      },
    }),
  });
  await expect(
    screen.findByText(
      "missing-copy.txt is no longer available. Upload it again to send.",
    ),
  ).resolves.toBeVisible();
  expect(composer).toHaveTextContent("Text kept from an inaccessible copy");
  expect(document.body).not.toHaveTextContent("Remove missing-copy.txt");
  expect(fastButton("Remove available-copy.txt")).toBeVisible();

  placeCaretAtEnd(composer);
  const portuguesePlainText =
    "Resumo copiado em duas linhas\nContinuação preservada\n\nAnexos:\n- locale-copy.txt: " +
    localized.url;
  fireEvent.paste(composer, {
    clipboardData: richClipboard(
      {
        text: "",
        attachments: [localized],
      },
      portuguesePlainText,
    ),
  });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Resumo copiado em duas linhas");
    expect(composer).toHaveTextContent("Continuação preservada");
    expect(fastButton("Remove locale-copy.txt")).toBeVisible();
  });
});

test("Paste plain and multi-line text at the current draft position", async () => {
  const thread = continuityThread(15, 1, "Paste position");
  const referenced = continuityThread(15, 2, "Launch reference");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 15,
    threads: [thread, referenced],
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "Alpha omega");
  placeCaret(composer, "Alpha omega", 6);
  await userEvent.paste("middle ");
  await waitFor(() => {
    expect(composer).toHaveTextContent("Alpha middle omega");
  });

  placeCaretAtEnd(composer);
  fireEvent.paste(composer, {
    clipboardData: richClipboard({
      text:
        `\nFirst pasted line\n[Launch reference](/chats/${referenced.id})` +
        "\nLast pasted line",
      attachments: [],
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "\nFirst pasted line\n" },
          {
            type: "chat_thread",
            threadId: referenced.id,
            titleSnapshot: "Launch reference",
          },
          { type: "text", text: "\nLast pasted line" },
        ],
      },
    }),
  });

  await waitFor(() => {
    expect(composer).toHaveTextContent("Alpha middle omega");
    expect(composer).toHaveTextContent("First pasted line");
    expect(composer).toHaveTextContent("Launch reference");
    expect(composer).toHaveTextContent("Last pasted line");
  });
  const reference = composer.querySelector<HTMLElement>(
    `[data-chat-thread-mention="${referenced.id}"]`,
  );
  expect(reference).toBeVisible();
  const finalText = composer.textContent ?? "";
  expect(finalText.indexOf("First pasted line")).toBeLessThan(
    finalText.indexOf("Launch reference"),
  );
  expect(finalText.indexOf("Launch reference")).toBeLessThan(
    finalText.indexOf("Last pasted line"),
  );
});
