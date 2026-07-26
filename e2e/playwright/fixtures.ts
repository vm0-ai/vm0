import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test as base } from "@playwright/test";

export { expect };

export const test = base.extend({
  context: async ({ context }, use) => {
    // Every page load runs `clerk.load()`, which handshakes with the Clerk
    // Frontend API — including tests that only restore a saved storage
    // state. Without the testing token that handshake is subject to bot
    // protection and rate limiting, and a throttled `/v1/client` leaves the
    // app parked on its bootstrap skeleton forever. Registering here also
    // buys the retry on 429/502/503/504 that the token helper performs.
    await setupClerkTestingToken({ context });

    const apiUrl = process.env.VM0_API_BACKEND_URL;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (apiUrl && bypassSecret) {
      const apiOrigin = new URL(apiUrl).origin;
      await context.route(`${apiOrigin}/**`, async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-vercel-protection-bypass": bypassSecret,
          },
        });
      });
    }

    await use(context);
  },
});
