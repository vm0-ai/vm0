import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  type Request,
  type Response as PlaywrightResponse,
  type Route,
  test as base,
  type BrowserContext,
} from "@playwright/test";
import {
  apiPreviewHeaders,
  installApiPreviewHeadersForUrl,
} from "./lib/api-preview-auth";

export { expect };

export async function installApiPreviewHeaders(
  context: BrowserContext,
): Promise<void> {
  const apiUrl = process.env.VM0_API_BACKEND_URL;
  if (!apiUrl) {
    return;
  }
  await installApiPreviewHeadersForUrl(context, apiUrl);
}

export async function fetchApiPreviewRouteJson(route: Route): Promise<unknown> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() !== "GET") {
    throw new Error(`API preview JSON replay requires GET for ${url.pathname}`);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        ...request.headers(),
        ...apiPreviewHeaders(),
      },
      method: "GET",
      redirect: "manual",
    });
  } catch {
    throw new Error(`API preview request failed for ${url.pathname}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `API preview request returned ${response.status} for ${url.pathname}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`API preview returned invalid JSON for ${url.pathname}`);
  }
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

    try {
      await use(context);
    } finally {
      await context.unrouteAll({ behavior: "ignoreErrors" });
    }
  },
  page: async ({ page }, use) => {
    const failedRequest = (request: Request) => {
      const url = new URL(request.url());
      console.error(
        `[playwright:http] ${request.method()} failed ${url.origin}${url.pathname}: ${request.failure()?.errorText ?? "unknown error"}`,
      );
    };
    const failedResponse = (response: PlaywrightResponse) => {
      if (response.status() < 400) {
        return;
      }
      const url = new URL(response.url());
      console.error(
        `[playwright:http] ${response.request().method()} ${response.status()} ${url.origin}${url.pathname}`,
      );
    };
    page.on("requestfailed", failedRequest);
    page.on("response", failedResponse);
    try {
      await use(page);
    } finally {
      page.off("requestfailed", failedRequest);
      page.off("response", failedResponse);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  },
});
