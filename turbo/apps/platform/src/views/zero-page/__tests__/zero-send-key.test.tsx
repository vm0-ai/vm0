import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const SOFTWARE_KEYBOARD_HEIGHT_PX = 336;

// A software keyboard shrinks the visual viewport while the layout viewport
// keeps its height.
function occludeVisualViewport(): void {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      height: window.innerHeight - SOFTWARE_KEYBOARD_HEIGHT_PX,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      width: window.innerWidth,
    }),
  });
  onTestFinished(() => {
    if (original) {
      Object.defineProperty(window, "visualViewport", original);
      return;
    }
    Reflect.deleteProperty(window, "visualViewport");
  });
}

async function openComposer(sendMode: "enter" | "cmd-enter") {
  context.mocks.data.userPreferences({ sendMode });
  mockChatLifecycle(context);
  detachedSetupPage({ context, path: "/" });

  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

describe("zero send key", () => {
  it("sends with Enter mode while Shift+Enter keeps the draft editable", async () => {
    const user = userEvent.setup({ delay: null });
    const enterTextarea = await openComposer("enter");

    await fill(enterTextarea, "Send with Enter");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Send with Enter")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("does not send Shift+Enter in Enter mode", async () => {
    const user = userEvent.setup({ delay: null });
    const textarea = await openComposer("enter");

    await fill(textarea, "Keep this draft");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(textarea.textContent ?? "").toContain("Keep this draft");
  });

  it("sends with Cmd+Enter mode while plain Enter keeps the draft", async () => {
    const user = userEvent.setup({ delay: null });
    const textarea = await openComposer("cmd-enter");

    await fill(textarea, "Keep until command enter");
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(textarea.textContent ?? "").toContain("Keep until command enter");

    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(screen.getByText("Keep until command enter")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("avoids accidental sends during IME composition", async () => {
    const textarea = await openComposer("enter");

    await fill(textarea, "Composing text");
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(textarea.textContent ?? "").toContain("Composing text");
  });

  it("keeps plain Enter as a newline but sends with modified Enter on touch devices", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });
    const touchTextarea = await openComposer("enter");
    await fill(touchTextarea, "Touch device draft");
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(touchTextarea.textContent ?? "").toContain("Touch device draft");

    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(screen.getByText("Touch device draft")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("avoids accidental modified sends during IME composition on touch devices", async () => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });
    const textarea = await openComposer("enter");

    await fill(textarea, "Composing on touch device");
    fireEvent.keyDown(textarea, {
      key: "Enter",
      ctrlKey: true,
      keyCode: 229,
    });

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(textarea.textContent ?? "").toContain("Composing on touch device");
  });

  it("sends with Enter on touch devices with a fine pointer", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
    });
    const keyboardTextarea = await openComposer("enter");

    await fill(keyboardTextarea, "Send from Magic Keyboard");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Send from Magic Keyboard")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("keeps plain Enter as a newline while the software keyboard is open", async () => {
    const user = userEvent.setup({ delay: null });
    // WebKit reports a fine pointer on iPhones, including standalone PWAs.
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
    });
    occludeVisualViewport();
    const softwareKeyboardTextarea = await openComposer("enter");

    await fill(softwareKeyboardTextarea, "Software keyboard draft");
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(softwareKeyboardTextarea.textContent ?? "").toContain(
      "Software keyboard draft",
    );

    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(screen.getByText("Software keyboard draft")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("always sends with modified Enter on touch devices with a fine pointer", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
    });
    const keyboardTextarea = await openComposer("enter");

    await fill(keyboardTextarea, "Send with modified Enter");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(screen.getByText("Send with modified Enter")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });
});
