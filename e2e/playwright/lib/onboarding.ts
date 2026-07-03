import type { Page } from "@playwright/test";
import { deriveServiceOrigin } from "../playwright.config";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function routeOnboardingApiToPreview(
  page: Page,
  onboardingUrl: string,
  apiUrl: string,
  options: { readonly authorizationToken?: string } = {},
): Promise<void> {
  const onboardingApiOrigin = deriveServiceOrigin(onboardingUrl, "api");
  const targetApiOrigin = new URL(apiUrl).origin;
  if (onboardingApiOrigin === targetApiOrigin) {
    return;
  }

  await page.route(
    new RegExp(`^${escapeRegExp(onboardingApiOrigin)}/api/`),
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const targetUrl = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        targetApiOrigin,
      );
      const headers = route.request().headers();
      if (options.authorizationToken) {
        headers.authorization = `Bearer ${options.authorizationToken}`;
      }
      const response = await route.fetch({
        headers,
        url: targetUrl.toString(),
      });
      await route.fulfill({ response });
    },
  );
}
