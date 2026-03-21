import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockSendMode(mode: "enter" | "cmd-enter") {
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json({
        timezone: null,
        notifyEmail: false,
        notifySlack: false,
        pinnedAgentIds: [],
        sendMode: mode,
      });
    }),
  );
}

async function renderChatPage(sendMode: "enter" | "cmd-enter" = "enter") {
  mockChatAPI();
  mockSendMode(sendMode);
  await setupPage({ context, path: "/" });
}

function getTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
  );
}

describe("send-key behavior — enter mode", () => {
  it("should send when Enter is pressed", async () => {
    await renderChatPage("enter");

    const textarea = await getTextarea();
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const preventDefault = vi.fn();
    act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          {
            preventDefault,
          },
        ),
      );
    });

    expect(preventDefault).toHaveBeenCalledWith();
  });

  it("should not send when Shift+Enter is pressed", async () => {
    await renderChatPage("enter");

    const textarea = await getTextarea();
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const preventDefault = vi.fn();
    act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", {
            key: "Enter",
            shiftKey: true,
            bubbles: true,
          }),
          { preventDefault },
        ),
      );
    });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("send-key behavior — cmd-enter mode", () => {
  it("should send when Cmd+Enter is pressed", async () => {
    await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const preventDefault = vi.fn();
    act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            bubbles: true,
          }),
          { preventDefault },
        ),
      );
    });

    expect(preventDefault).toHaveBeenCalledWith();
  });

  it("should not send when plain Enter is pressed", async () => {
    await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const preventDefault = vi.fn();
    act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          { preventDefault },
        ),
      );
    });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("send-key behavior — IME composition", () => {
  it("should not send during IME composition even when Enter is pressed", async () => {
    await renderChatPage("enter");

    const textarea = await getTextarea();
    fireEvent.change(textarea, { target: { value: "Hello" } });

    // Start IME composition
    fireEvent.compositionStart(textarea);

    const preventDefault = vi.fn();
    act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          { preventDefault },
        ),
      );
    });

    expect(preventDefault).not.toHaveBeenCalled();

    // End IME composition
    fireEvent.compositionEnd(textarea);
  });
});
