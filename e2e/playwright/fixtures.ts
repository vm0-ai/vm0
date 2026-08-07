import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  test as base,
  type BrowserContext,
} from "@playwright/test";

export { expect };

export async function installApiPreviewHeaders(
  context: BrowserContext,
): Promise<void> {
  const apiUrl = process.env.VM0_API_BACKEND_URL;
  if (!apiUrl) {
    return;
  }
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error("Cloudflare Access credentials must be configured together");
  }
  if (!bypassSecret && !accessClientId) {
    return;
  }
  const apiOrigin = new URL(apiUrl).origin;
  await context.route(`${apiOrigin}/**`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        ...(bypassSecret
          ? { "x-vercel-protection-bypass": bypassSecret }
          : {}),
        ...(accessClientId && accessClientSecret
          ? {
              "cf-access-client-id": accessClientId,
              "cf-access-client-secret": accessClientSecret,
            }
          : {}),
      },
    });
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
