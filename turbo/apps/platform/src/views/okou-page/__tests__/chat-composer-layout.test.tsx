import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findComposer,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const APP_HOST = "app.vm0.ai";

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
