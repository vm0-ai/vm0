import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { setupBootstrap } from "../../__tests__/page-helper.ts";
import { pathname$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const THREAD_ID = "00000000-0000-4000-8000-000000000001";

async function setupNotificationClickListener(origin = "https://app.okou.ai") {
  context.mocks.browser.url(`${origin}${ROUTES.error}`);
  const serviceWorker = context.mocks.browser.serviceWorker();
  await setupBootstrap({ context, path: ROUTES.error });
  return serviceWorker;
}

describe("notification click navigation", () => {
  it.each([
    [
      "an absolute Okou",
      "https://app.okou.ai",
      `https://app.okou.ai/chats/${THREAD_ID}`,
    ],
    [
      "an absolute VM0",
      "https://app.vm0.ai",
      `https://app.vm0.ai/chats/${THREAD_ID}`,
    ],
    ["a relative", "https://app.okou.ai", `/chats/${THREAD_ID}`],
  ])("navigates to the chat from %s URL", async (_name, origin, url) => {
    const serviceWorker = await setupNotificationClickListener(origin);

    serviceWorker.dispatchMessage({ type: "NOTIFICATION_CLICK", url });

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe(`/chats/${THREAD_ID}`);
    });
  });

  it.each([
    ["an external", `https://example.com/chats/${THREAD_ID}`],
    ["a cross-brand", `https://app.vm0.ai/chats/${THREAD_ID}`],
    ["a non-chat", `https://app.okou.ai/activities/${THREAD_ID}`],
  ])("does not navigate for %s URL", async (_name, url) => {
    const serviceWorker = await setupNotificationClickListener();

    serviceWorker.dispatchMessage({ type: "NOTIFICATION_CLICK", url });

    expect(context.store.get(pathname$)).toBe(ROUTES.error);
  });
});
