import { describe, expect, it } from "vitest";
// eslint-disable-next-line ccstate/prefer-user-event -- fireEvent needed for compositionStart/End which have no userEvent equivalent; confirmed by ethan@vm0.ai
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPI() {
  let messageSent = false;

  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.post("*/api/zero/chat/messages", () => {
      messageSent = true;
      return HttpResponse.json(
        {
          runId: "run-test-1",
          threadId: "thread-test-1",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
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
      });
    }),
  );
}

async function renderChatPage(sendMode: "enter" | "cmd-enter" = "enter") {
  const api = mockChatAPI();
  mockSendMode(sendMode);
  await setupPage({ context, path: "/" });
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
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.wasMessageSent()).toBeTruthy();
    });
  });

  it("should not send when Shift+Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(api.wasMessageSent()).toBeFalsy();
  });
});

describe("send-key behavior — cmd-enter mode", () => {
  it("should send when Cmd+Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(api.wasMessageSent()).toBeTruthy();
    });
  });

  it("should not send when plain Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("cmd-enter");

    const textarea = await getTextarea();
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    await user.keyboard("{Enter}");

    expect(api.wasMessageSent()).toBeFalsy();
  });
});

describe("send-key behavior — IME composition", () => {
  it("should not send during IME composition even when Enter is pressed", async () => {
    const user = userEvent.setup();
    const api = await renderChatPage("enter");

    const textarea = await getTextarea();
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    // Start IME composition
    fireEvent.compositionStart(textarea);

    await user.keyboard("{Enter}");

    expect(api.wasMessageSent()).toBeFalsy();

    // End IME composition
    fireEvent.compositionEnd(textarea);
  });
});
