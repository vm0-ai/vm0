import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  type APIResponse,
  expect,
  type Route,
  test as base,
  type BrowserContext,
} from "@playwright/test";
import { apiPreviewHeaders } from "./lib/api-preview-auth";

export { expect };

export async function installApiPreviewHeaders(
  context: BrowserContext,
): Promise<void> {
  const apiUrl = process.env.VM0_API_BACKEND_URL;
  if (!apiUrl) {
    return;
  }
  const previewHeaders = apiPreviewHeaders();
  if (Object.keys(previewHeaders).length === 0) {
    return;
  }
  const apiOrigin = new URL(apiUrl).origin;
  await context.route(`${apiOrigin}/**`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        ...previewHeaders,
      },
    });
  });
}

export function fetchApiPreviewRoute(route: Route): Promise<APIResponse> {
  return route.fetch({
    headers: {
      ...route.request().headers(),
      ...apiPreviewHeaders(),
    },
  });
}

export const test = base.extend({
  context: async ({ context }, use) => {
    // Every page load runs `clerk.load()`, which handshakes with the Clerk
    // Frontend API — including tests that only restore a saved storage
    // state. Without the testing token that handshake is subject to bot
    // protection and rate limiting, and a throttled `/v1/client` leaves the
    // app parked on its bootstrap skeleton forever. Registering here also
    // buys the retry on 429/502/503/504 that the token helper performs.
    await setupClerkTestingToken({ context });

    await installApiPreviewHeaders(context);

    await use(context);
  },
});
