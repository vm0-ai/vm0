import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findComposer,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const APP_HOST = "app.vm0.ai";
const THREAD_ID = "b0000000-0000-4000-a000-000000000925";

function installViewportWidth(width: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(window, "innerWidth", descriptor);
        return;
      }
      Reflect.deleteProperty(window, "innerWidth");
    },
    { once: true },
  );
}

test("Keep the iPadOS composer from stealing focus", async () => {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  );
  context.mocks.browser.platform("MacIntel");
  context.mocks.browser.maxTouchPoints(5);
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)" || query === "(any-pointer: fine)";
  });
  installMessageExperienceChat();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    host: APP_HOST,
  });

  const editor = await findComposer();
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    throw new Error("The page has no active HTML element");
  }
  expect(editor).not.toHaveFocus();
  expect(editor.closest(".zero-composer")).not.toContainElement(activeElement);
});

test("Give a new wide-layout chat comfortable writing space", async () => {
  installViewportWidth(1280);
  context.mocks.browser.matchMedia(false);
  installMessageExperienceChat();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    host: APP_HOST,
  });

  const editor = await findComposer();
  expect(editor).toHaveClass("min-h-[96px]");
});

test("Keep an existing narrow-layout composer compact", async () => {
  installViewportWidth(390);
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "b0000000-0000-4000-a000-000000000926",
        role: "assistant",
        content: "The compact conversation is ready.",
        runId: "layout-run",
        createdAt: "2026-08-01T10:00:00Z",
      },
    ],
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: APP_HOST,
  });

  const editor = await findComposer();
  expect(editor).toHaveClass("min-h-[68px]");
});
