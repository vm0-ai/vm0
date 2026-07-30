import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { setupKeyboardDismissGesture } from "../keyboard-dismiss-gesture.ts";

interface TouchPoint {
  x: number;
  y: number;
}

function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: TouchPoint[],
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: type === "touchmove",
  });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: points.map((point) => {
      return { clientX: point.x, clientY: point.y };
    }),
  });
  target.dispatchEvent(event);
  return event;
}

function setKeyboardOpen(open: boolean): void {
  if (open) {
    document.documentElement.dataset.keyboardOpen = "true";
  } else {
    delete document.documentElement.dataset.keyboardOpen;
  }
}

function mountChatSurfaces(): {
  composerEditor: HTMLDivElement;
  historyMessage: HTMLDivElement;
} {
  const history = document.createElement("div");
  history.dataset.scrollContainer = "";
  const historyMessage = document.createElement("div");
  history.append(historyMessage);

  const composer = document.createElement("footer");
  composer.dataset.chatComposer = "";
  const composerEditor = document.createElement("div");
  composerEditor.contentEditable = "true";
  composerEditor.tabIndex = 0;
  composer.append(composerEditor);

  document.body.append(history, composer);
  return { composerEditor, historyMessage };
}

function makeEditorScrollable(
  editor: HTMLElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop,
  }: { clientHeight: number; scrollHeight: number; scrollTop: number },
): void {
  editor.style.overflowY = "auto";
  Object.defineProperty(editor, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(editor, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(editor, "scrollTop", {
    configurable: true,
    value: scrollTop,
    writable: true,
  });
}

function startDismissGesture(): void {
  onTestFinished(setupKeyboardDismissGesture());
}

afterEach(() => {
  document.body.replaceChildren();
  setKeyboardOpen(false);
});

describe("keyboard dismiss gesture", () => {
  it("closes the keyboard on a downward swipe over the chat history", () => {
    const { composerEditor, historyMessage } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(historyMessage, "touchstart", [{ x: 100, y: 200 }]);
    const move = dispatchTouch(historyMessage, "touchmove", [
      { x: 102, y: 240 },
    ]);

    expect(document.activeElement).not.toBe(composerEditor);
    // History swipes keep scrolling natively while the keyboard closes.
    expect(move.defaultPrevented).toBe(false);
  });

  it("closes the keyboard on a downward swipe over the composer", () => {
    const { composerEditor } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    dispatchTouch(composerEditor, "touchmove", [{ x: 100, y: 540 }]);

    expect(document.activeElement).not.toBe(composerEditor);
  });

  it("blocks upward drags from moving the composer away from the keyboard", () => {
    const { composerEditor } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const move = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 460 },
    ]);

    expect(move.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(composerEditor);
  });

  it("lets an upward drag scroll a composer draft that has more content below", () => {
    const { composerEditor } = mountChatSurfaces();
    makeEditorScrollable(composerEditor, {
      clientHeight: 80,
      scrollHeight: 300,
      scrollTop: 0,
    });
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const move = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 460 },
    ]);

    expect(move.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composerEditor);
  });

  it("keeps a decided pass-through gesture from locking later", () => {
    const { composerEditor } = mountChatSurfaces();
    makeEditorScrollable(composerEditor, {
      clientHeight: 80,
      scrollHeight: 300,
      scrollTop: 0,
    });
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    dispatchTouch(composerEditor, "touchmove", [{ x: 100, y: 460 }]);
    const laterMove = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 400 },
    ]);

    expect(laterMove.defaultPrevented).toBe(false);
  });

  it("ignores horizontal swipes over the composer", () => {
    const { composerEditor } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const move = dispatchTouch(composerEditor, "touchmove", [
      { x: 160, y: 510 },
    ]);

    expect(move.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composerEditor);
  });

  it("does nothing while the keyboard is closed", () => {
    const { composerEditor, historyMessage } = mountChatSurfaces();
    composerEditor.focus();
    startDismissGesture();

    dispatchTouch(historyMessage, "touchstart", [{ x: 100, y: 200 }]);
    const historyMove = dispatchTouch(historyMessage, "touchmove", [
      { x: 100, y: 240 },
    ]);
    dispatchTouch(historyMessage, "touchend", []);
    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const composerMove = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 460 },
    ]);

    expect(document.activeElement).toBe(composerEditor);
    expect(historyMove.defaultPrevented).toBe(false);
    expect(composerMove.defaultPrevented).toBe(false);
  });

  it("ignores swipes outside the chat surfaces", () => {
    const { composerEditor } = mountChatSurfaces();
    const outside = document.createElement("div");
    document.body.append(outside);
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(outside, "touchstart", [{ x: 100, y: 200 }]);
    dispatchTouch(outside, "touchmove", [{ x: 100, y: 260 }]);

    expect(document.activeElement).toBe(composerEditor);
  });

  it("abandons multi-touch gestures", () => {
    const { composerEditor } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    startDismissGesture();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const move = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 540 },
      { x: 140, y: 540 },
    ]);

    expect(move.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composerEditor);
  });

  it("stops handling touches after cleanup", () => {
    const { composerEditor } = mountChatSurfaces();
    composerEditor.focus();
    setKeyboardOpen(true);
    const cleanup = setupKeyboardDismissGesture();
    cleanup();

    dispatchTouch(composerEditor, "touchstart", [{ x: 100, y: 500 }]);
    const move = dispatchTouch(composerEditor, "touchmove", [
      { x: 100, y: 460 },
    ]);

    expect(move.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composerEditor);
  });
});
