import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { expect, test, vi } from "vitest";

import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000903";

function setupNewChat(
  sendMode: SendMode,
  sentMessages: string[],
): Promise<void> {
  context.mocks.data.userPreferences({ sendMode });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    onSendRequest: ({ prompt }) => {
      sentMessages.push(prompt);
    },
  });
  return setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.vm0.ai",
  });
}

async function editableComposer(): Promise<HTMLElement> {
  const editor = await screen.findByRole("textbox", { name: "Message" });
  expect(editor).toHaveAttribute("contenteditable", "true");
  return editor;
}

function mountedComposer(): HTMLElement {
  const editor = document.querySelector(
    '.okou-composer [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Editable message composer not found");
  }
  return editor;
}

async function enterDraft(message: string): Promise<HTMLElement> {
  await fill(await editableComposer(), message);
  await waitFor(() => {
    expect(mountedComposer()).toHaveTextContent(message);
  });
  return mountedComposer();
}

function pressEnter(
  editor: HTMLElement,
  options: {
    readonly ctrlKey?: boolean;
    readonly isComposing?: boolean;
    readonly keyCode?: number;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
  } = {},
): void {
  fireEvent.keyDown(editor, {
    key: "Enter",
    code: "Enter",
    ...options,
  });
}

function modifiedEnterOptions(): { ctrlKey: true } | { metaKey: true } {
  return /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)
    ? { metaKey: true }
    : { ctrlKey: true };
}

function stopButton(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Stop";
  });
}

async function expectSent(
  sentMessages: readonly string[],
  message: string,
): Promise<void> {
  await waitFor(() => {
    expect(sentMessages).toStrictEqual([message]);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(stopButton()).toBeInTheDocument();
  });
}

async function expectEditableAfterNewLine(message: string): Promise<void> {
  await waitFor(() => {
    const editor = mountedComposer();
    expect(editor).toHaveTextContent(message);
    expect(editor.querySelectorAll("p").length).toBeGreaterThan(1);
  });
}

function mockPointerEnvironment({
  coarse,
  fine,
}: {
  readonly coarse: boolean;
  readonly fine: boolean;
}): void {
  const originalMatchMedia = window.matchMedia.bind(window);
  const matchMedia = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query: string) => {
      const result = originalMatchMedia(query);
      if (query === "(pointer: coarse)") {
        Object.defineProperty(result, "matches", {
          configurable: true,
          value: coarse,
        });
      }
      if (query === "(any-pointer: fine)") {
        Object.defineProperty(result, "matches", {
          configurable: true,
          value: fine,
        });
      }
      return result;
    });
  context.signal.addEventListener(
    "abort",
    () => {
      matchMedia.mockRestore();
    },
    { once: true },
  );
}

function mockOpenSoftwareKeyboard(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = {
    addEventListener: vi.fn<() => void>(),
    dispatchEvent: vi.fn<() => boolean>(() => {
      return true;
    }),
    height: Math.max(1, window.innerHeight - 300),
    offsetLeft: 0,
    offsetTop: 0,
    onresize: null,
    onscroll: null,
    pageLeft: 0,
    pageTop: 0,
    removeEventListener: vi.fn<() => void>(),
    scale: 1,
    width: window.innerWidth,
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(window, "visualViewport", descriptor);
        return;
      }
      Reflect.deleteProperty(window, "visualViewport");
    },
    { once: true },
  );
}

test("Enter sends a message in Enter mode", async () => {
  const sentMessages: string[] = [];
  await setupNewChat("enter", sentMessages);
  const message = "Prepare the launch checklist";
  const editor = await enterDraft(message);

  pressEnter(editor);

  await expectSent(sentMessages, message);
  expect(sentMessages).toStrictEqual([message]);
});

test("Enter sends when a touch device has a hardware keyboard", async () => {
  const sentMessages: string[] = [];
  mockPointerEnvironment({ coarse: true, fine: true });
  await setupNewChat("enter", sentMessages);
  const message = "Send from the tablet keyboard";
  const editor = await enterDraft(message);

  pressEnter(editor);

  await expectSent(sentMessages, message);
  expect(sentMessages).toStrictEqual([message]);
});

test("Confirming IME composition does not send a message", async () => {
  const user = userEvent.setup();
  const sentMessages: string[] = [];
  await setupNewChat("enter", sentMessages);
  const editor = await enterDraft("日本語の下書き");

  fireEvent.compositionStart(editor);
  pressEnter(editor, { isComposing: true, keyCode: 229 });
  fireEvent.compositionEnd(editor);
  await user.type(mountedComposer(), "を続ける");

  await waitFor(() => {
    expect(mountedComposer()).toHaveTextContent("日本語の下書きを続ける");
  });
  expect(sentMessages).toHaveLength(0);
});

test("Modified Enter always sends from a hardware keyboard", async () => {
  const sentMessages: string[] = [];
  mockPointerEnvironment({ coarse: true, fine: true });
  await setupNewChat("enter", sentMessages);
  const message = "Use the modified hardware shortcut";
  const editor = await enterDraft(message);

  pressEnter(editor, modifiedEnterOptions());

  await expectSent(sentMessages, message);
  expect(sentMessages).toStrictEqual([message]);
});

test("Modified Enter sends only when that shortcut is selected", async () => {
  const sentMessages: string[] = [];
  await setupNewChat("cmd-enter", sentMessages);
  const message = "Keep editing before sending";
  const editor = await enterDraft(message);

  pressEnter(editor);

  await expectEditableAfterNewLine(message);
  expect(sentMessages).toHaveLength(0);

  pressEnter(mountedComposer(), modifiedEnterOptions());

  await expectSent(sentMessages, message);
});

test("Shift+Enter keeps a draft editable in Enter mode", async () => {
  const user = userEvent.setup();
  const sentMessages: string[] = [];
  await setupNewChat("enter", sentMessages);
  const message = "First line";
  const editor = await enterDraft(message);

  pressEnter(editor, { shiftKey: true });

  await expectEditableAfterNewLine(message);
  await user.type(mountedComposer(), "Second line");
  await waitFor(() => {
    expect(mountedComposer()).toHaveTextContent("First lineSecond line");
  });
  expect(sentMessages).toHaveLength(0);
});

test("An open software keyboard reserves Enter for editing", async () => {
  const sentMessages: string[] = [];
  mockPointerEnvironment({ coarse: true, fine: true });
  mockOpenSoftwareKeyboard();
  await setupNewChat("enter", sentMessages);
  const message = "Draft above the software keyboard";
  const editor = await enterDraft(message);

  pressEnter(editor);

  await expectEditableAfterNewLine(message);
  expect(sentMessages).toHaveLength(0);

  pressEnter(mountedComposer(), modifiedEnterOptions());

  await expectSent(sentMessages, message);
});

test("Touch devices reserve plain Enter for editing", async () => {
  const sentMessages: string[] = [];
  mockPointerEnvironment({ coarse: true, fine: false });
  await setupNewChat("enter", sentMessages);
  const message = "Draft on a touch-only device";
  const editor = await enterDraft(message);

  pressEnter(editor);

  await expectEditableAfterNewLine(message);
  expect(sentMessages).toHaveLength(0);

  pressEnter(mountedComposer(), modifiedEnterOptions());

  await expectSent(sentMessages, message);
});

test("IME confirmation does not send on a touch device", async () => {
  const user = userEvent.setup();
  const sentMessages: string[] = [];
  mockPointerEnvironment({ coarse: true, fine: false });
  await setupNewChat("enter", sentMessages);
  const editor = await enterDraft("入力中の下書き");

  fireEvent.compositionStart(editor);
  pressEnter(editor, {
    ...modifiedEnterOptions(),
    isComposing: true,
    keyCode: 229,
  });
  fireEvent.compositionEnd(editor);
  await user.type(mountedComposer(), "を保持");

  await waitFor(() => {
    expect(mountedComposer()).toHaveTextContent("入力中の下書きを保持");
  });
  expect(sentMessages).toHaveLength(0);
});
