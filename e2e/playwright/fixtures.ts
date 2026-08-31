import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test as base } from "@playwright/test";

import { resolveApiBackendUrl } from "./api-backend-url";
import { SharedWorkerRoutes } from "./lib/shared-worker-routes";
import { deriveAppUrl } from "./playwright.config";

export { expect };

const apiUrl = resolveApiBackendUrl();
const sharedDatabaseWorkerScript =
  /\/assets\/shared-database-worker-[^/?]+\.js(?:\?.*)?$/u;

interface WorkerRouteFixtures {
  readonly sharedWorkerRoutes: SharedWorkerRoutes;
}

export const test = base.extend<WorkerRouteFixtures>({
  context: async ({ context }, use) => {
    // Every page load runs `clerk.load()`, which handshakes with the Clerk
    // Frontend API — including tests that only restore a saved storage
    // state. Without the testing token that handshake is subject to bot
    // protection and rate limiting, and a throttled `/v1/client` leaves the
    // app parked on its bootstrap skeleton forever. Registering here also
    // buys the retry on 429/502/503/504 that the token helper performs.
    await setupClerkTestingToken({ context });

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

    try {
      await use(context);
    } finally {
      await context.unrouteAll({ behavior: "ignoreErrors" });
    }
  },
  page: async ({ page }, use) => {
    try {
      await use(page);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  },
  sharedWorkerRoutes: async ({ context }, use) => {
    const routes = await SharedWorkerRoutes.install({
      apiOrigin: apiUrl,
      bridgeOrigin: deriveAppUrl(apiUrl),
      context,
      workerScript: sharedDatabaseWorkerScript,
    });
    try {
      await use(routes);
    } finally {
      await routes.close();
    }
  },
});
