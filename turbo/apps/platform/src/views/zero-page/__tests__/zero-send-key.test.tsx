import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

async function openComposer(sendMode: "enter" | "cmd-enter") {
  context.mocks.data.userPreferences({ sendMode });
  mockChatLifecycle(context);
  detachedSetupPage({ context, path: "/" });

  return await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
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
    expect(textarea.value).toContain("Keep this draft");
  });

  it("sends with Cmd+Enter mode while plain Enter keeps the draft", async () => {
    const user = userEvent.setup({ delay: null });
    const textarea = await openComposer("cmd-enter");

    await fill(textarea, "Keep until command enter");
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(textarea.value).toContain("Keep until command enter");

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
    expect(textarea.value).toContain("Composing text");
  });

  it("avoids accidental sends on touch devices", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });
    const touchTextarea = await openComposer("enter");
    await fill(touchTextarea, "Touch device draft");
    await user.keyboard("{Enter}");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    expect(touchTextarea.value).toContain("Touch device draft");
  });
});
