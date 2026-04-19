import { describe, expect, it, beforeEach, vi } from "vitest";
// eslint-disable-next-line ccstate/prefer-user-event -- fireEvent needed for simulating IME keydown with isComposing; confirmed by ethan@vm0.ai
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { chatMessagesContract } from "@vm0/core";

const context = testContext();

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPI() {
  let messageSent = false;

  server.use(
    mockApi(chatMessagesContract.send, ({ respond }) => {
      messageSent = true;
      return respond(201, {
        runId: "run-test-1",
        threadId: "thread-test-1",
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
  );

  return {
    wasMessageSent: () => {
      return messageSent;
    },
    reset: () => {
      messageSent = false;
    },
  };
}

function mockSendMode(mode: "enter" | "cmd-enter") {
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json({
        timezone: null,
        pinnedAgentIds: [],
        sendMode: mode,
        captureNetworkBodiesRemaining: 0,
      });
    }),
  );
}

function renderChatPage(sendMode: "enter" | "cmd-enter" = "enter") {
  const api = mockChatAPI();
  mockSendMode(sendMode);
  detachedSetupPage({ context, path: "/" });
  return api;
}

function getTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });
}

describe("send-key behavior — enter mode", () => {
  it("should send when Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.wasMessageSent()).toBeTruthy();
    });
  });

  it("should not send when Shift+Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(api.wasMessageSent()).toBeFalsy();
  });
});

describe("send-key behavior — cmd-enter mode", () => {
  it("should send when Cmd+Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    // In test env (Linux), mod maps to Ctrl, not Meta
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(api.wasMessageSent()).toBeTruthy();
    });
  });

  it("should not send when plain Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    await user.keyboard("{Enter}");

    expect(api.wasMessageSent()).toBeFalsy();
  });
});

describe("send-key behavior — IME composition", () => {
  it("should not send during IME composition even when Enter is pressed", async () => {
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    // Simulate an Enter keydown during IME composition (keyCode 229).
    // jsdom does not link compositionStart to KeyboardEvent.isComposing,
    // so we fire a raw keydown with the IME keyCode directly.
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(api.wasMessageSent()).toBeFalsy();
  });
});

describe("send-key behavior — mobile (pointer: coarse)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      return {
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: () => {
          return undefined;
        },
        removeListener: () => {
          return undefined;
        },
        addEventListener: () => {
          return undefined;
        },
        removeEventListener: () => {
          return undefined;
        },
        dispatchEvent: () => {
          return false;
        },
      } as MediaQueryList;
    });
  });

  it("should not send when Enter is pressed on a touch device (enter mode)", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    await user.keyboard("{Enter}");

    expect(api.wasMessageSent()).toBeFalsy();
  });

  it("should not send when Cmd+Enter is pressed on a touch device (enter mode)", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await fill(textarea, "Hello");

    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(api.wasMessageSent()).toBeFalsy();
  });
});
