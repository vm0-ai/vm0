import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  feedbackItems,
  findButton,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";

function textNode(text: string): Text {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && node.data === text) {
      return node;
    }
  }
  throw new Error(`Passage ${text} is not rendered`);
}

// happy-dom has no layout or caret hit-testing. Model only that browser
// boundary; the page, selection gestures, toolbar and send path are real.
function mockTouchLayout(text: string, api: "webkit" | "standard" = "webkit") {
  let currentText = text;
  let currentTop = 100;
  const caret = (x: number) => {
    return {
      node: textNode(currentText),
      offset: Math.max(
        0,
        Math.min(currentText.length, Math.round((x - 20) / 5)),
      ),
    };
  };
  const name =
    api === "webkit" ? "caretRangeFromPoint" : "caretPositionFromPoint";
  const original = Object.getOwnPropertyDescriptor(document, name);
  Object.defineProperty(document, name, {
    configurable: true,
    value: (x: number) => {
      const position = caret(x);
      if (api === "standard") {
        return { offsetNode: position.node, offset: position.offset };
      }
      const range = document.createRange();
      range.setStart(position.node, position.offset);
      range.collapse(true);
      return range;
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (original) {
        Object.defineProperty(document, name, original);
      } else {
        Reflect.deleteProperty(document, name);
      }
    },
    { once: true },
  );
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Range) {
      return new DOMRect(
        20 + this.startOffset * 5,
        currentTop,
        (this.endOffset - this.startOffset) * 5,
        20,
      );
    },
  );
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
    this: Range,
  ) {
    const rect = this.getBoundingClientRect();
    return Object.assign([rect], {
      item: (index: number) => {
        return index === 0 ? rect : null;
      },
    });
  });
  return (nextText: string, top = 100) => {
    currentText = nextText;
    currentTop = top;
  };
}

function touchAt(offset: number, pointerId = 1) {
  return {
    pointerType: "touch",
    pointerId,
    isPrimary: true,
    clientX: 20 + offset * 5,
    clientY: 110,
  };
}

async function longPress(passage: HTMLElement, offset: number) {
  fireEvent.pointerDown(passage, touchAt(offset));
  await findButton("Quote");
  fireEvent.pointerUp(passage, touchAt(offset));
}

test("Touch selection survives release and quotes an adjusted range without a native selection", async () => {
  const sends: CapturedChatSend[] = [];
  mockTouchLayout(PASSAGE);
  installCapabilityChat({
    events: completedConversation(PASSAGE),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const passage = await screen.findByText(PASSAGE);

  await longPress(passage, PASSAGE.indexOf("launch") + 1);

  expect(window.getSelection()?.toString()).toBe("");
  expect(fireEvent.contextMenu(passage)).toBeFalsy();
  expect(fireEvent.click(passage, { detail: 1 })).toBeFalsy();
  await expect(findButton("Quote")).resolves.toBeVisible();

  const endHandle = screen.getByLabelText("Adjust selection end");
  fireEvent.pointerDown(endHandle, touchAt(PASSAGE.indexOf(" plan")));
  fireEvent.pointerMove(endHandle, touchAt(PASSAGE.indexOf(" has")));
  fireEvent.pointerUp(endHandle, touchAt(PASSAGE.indexOf(" has")));
  await quoteSelectedPassage();

  expect(feedbackItems()[0]).toHaveTextContent("launch plan");
  expect(
    screen.queryByLabelText("Adjust selection end"),
  ).not.toBeInTheDocument();
  click(await findButton("Send"));
  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      quote: "launch plan",
      range: { start: PASSAGE.indexOf("launch"), end: PASSAGE.indexOf(" has") },
    }),
  );
});

test.each(["button", "keyboard"])(
  "Touch copy via %s segments Chinese text with the standard caret API",
  async (input) => {
    const text = "确认流程已经做好，接下来验证移动端。";
    const clipboard = context.mocks.browser.clipboardWriteText();
    mockTouchLayout(text, "standard");
    installCapabilityChat({ events: completedConversation(text) });
    await setupPage({ context, path: RUN_PATH });
    await readyChat();
    const passage = await screen.findByText(text);

    await longPress(passage, 0);
    expect(
      fireEvent.click(await findButton("Copy"), { detail: 1 }),
    ).toBeFalsy();
    if (input === "keyboard") {
      fireEvent.keyDown(document, { key: "c", ctrlKey: true });
    } else {
      click(await findButton("Copy"));
    }

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual(["确认"]);
    });
    expect(window.getSelection()?.toString()).toBe("");
    expect(
      screen.queryByLabelText("Adjust selection start"),
    ).not.toBeInTheDocument();
  },
);

test("Touch selection starts on a complete Unicode character without the word segmentation API", async () => {
  const text = "🧭 Launch plan.";
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockTouchLayout(text, "standard");
  installCapabilityChat({ events: completedConversation(text) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const segmenter = Intl.Segmenter;
  Object.defineProperty(Intl, "Segmenter", { value: undefined });
  context.signal.addEventListener(
    "abort",
    () => {
      Object.defineProperty(Intl, "Segmenter", { value: segmenter });
    },
    { once: true },
  );

  await longPress(await screen.findByText(text), 1);
  click(await findButton("Copy"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["🧭"]);
  });
  expect(window.getSelection()?.toString()).toBe("");
});

test("Touch selection leaves editing and link menus available and returns to native mouse selection", async () => {
  mockTouchLayout(PASSAGE);
  installCapabilityChat({
    events: completedConversation(
      `${PASSAGE}\n\n[Reference](https://example.com)`,
    ),
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const passage = await screen.findByText(PASSAGE);
  const composer = screen.getByRole("textbox", { name: "Message" });
  const link = await screen.findByText("Reference");

  await longPress(passage, PASSAGE.indexOf("launch"));
  fireEvent.pointerDown(composer, touchAt(0));
  fireEvent.pointerUp(composer, touchAt(0));
  expect(fireEvent.contextMenu(composer)).toBeTruthy();
  expect(
    screen.queryByLabelText("Adjust selection start"),
  ).not.toBeInTheDocument();
  fireEvent.pointerDown(link, touchAt(0));
  fireEvent.pointerUp(link, touchAt(0));
  expect(fireEvent.contextMenu(link)).toBeTruthy();

  fireEvent.pointerDown(passage, {
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
  });
  await selectPassage("launch plan");
  expect(window.getSelection()?.toString()).toBe("launch plan");
  expect(fireEvent.contextMenu(passage)).toBeTruthy();
  expect(
    screen.queryByLabelText("Adjust selection start"),
  ).not.toBeInTheDocument();
  await expect(findButton("Quote")).resolves.toBeVisible();
});

test("Scroll and multi-touch gestures can cancel a pending press before another selection", async () => {
  mockTouchLayout(PASSAGE);
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const passage = await screen.findByText(PASSAGE);

  fireEvent.pointerDown(passage, touchAt(0));
  fireEvent.pointerMove(passage, touchAt(8));
  expect(
    fireEvent.touchMove(passage, { touches: [{ identifier: 1 }] }),
  ).toBeTruthy();
  fireEvent.pointerCancel(passage, touchAt(8));
  fireEvent.pointerDown(passage, touchAt(0));
  fireEvent.pointerDown(passage, { ...touchAt(5, 2), isPrimary: false });
  expect(
    fireEvent.touchMove(passage, {
      touches: [{ identifier: 1 }, { identifier: 2 }],
    }),
  ).toBeTruthy();
  fireEvent.pointerUp(passage, touchAt(0));
  fireEvent.pointerUp(passage, touchAt(5, 2));

  await longPress(passage, PASSAGE.indexOf("stages"));
  await quoteSelectedPassage();
  expect(feedbackItems()[0]).toHaveTextContent("stages");
});

test("A viewport change repositions a touch selection after keyboard dismissal", async () => {
  const moveText = mockTouchLayout(PASSAGE);
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const passage = await screen.findByText(PASSAGE);
  screen.getByRole("textbox", { name: "Message" }).focus();

  await longPress(passage, PASSAGE.indexOf("launch"));
  expect(screen.getByLabelText("Adjust selection start")).toBeVisible();
  moveText(PASSAGE, 300);
  fireEvent(window, new Event("resize"));
  expect(screen.getByLabelText("Adjust selection start")).toHaveStyle({
    top: "278px",
  });
  await quoteSelectedPassage();
  expect(feedbackItems()[0]).toHaveTextContent("launch");
  expect(window.getSelection()?.toString()).toBe("");
});

test("Touch copy preserves paragraph boundaries across text nodes", async () => {
  const first = "First paragraph.";
  const second = "Second paragraph.";
  const pointAtText = mockTouchLayout(first);
  const clipboard = context.mocks.browser.clipboardWriteText();
  installCapabilityChat({
    events: completedConversation(`${first}\n\n${second}`),
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const passage = await screen.findByText(first);
  await longPress(passage, 0);
  const endHandle = screen.getByLabelText("Adjust selection end");
  fireEvent.pointerDown(endHandle, touchAt(5));
  pointAtText(second);
  fireEvent.pointerMove(endHandle, touchAt(second.length));
  fireEvent.pointerUp(endHandle, touchAt(second.length));
  click(await findButton("Copy"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([`${first}\n\n${second}`]);
  });
});
