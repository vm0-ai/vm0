import { expect, test as base, type Page } from "@playwright/test";
import { deriveApiUrl, deriveAppUrl } from "./playwright.config";

export { expect };

export const test = base.extend({
  page: async ({ page }, use) => {
    await installVercelProtectionBypass(page);
    await use(page);
  },
});

async function installVercelProtectionBypass(page: Page): Promise<void> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const webUrl = process.env.VM0_API_URL;
  if (!bypass || !webUrl) {
    return;
  }

  const protectedOrigins = new Set(
    [webUrl, deriveAppUrl(webUrl), deriveApiUrl(webUrl)].map((url) => {
      return new URL(url).origin;
    }),
  );

  await page.route("**/*", async (route) => {
    const request = route.request();
    const origin = new URL(request.url()).origin;
    if (!protectedOrigins.has(origin)) {
      await route.continue();
      return;
    }

    await route.continue({
      headers: {
        ...request.headers(),
        "x-vercel-protection-bypass": bypass,
      },
    });
  });
}
