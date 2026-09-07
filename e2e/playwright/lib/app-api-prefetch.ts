import type { Page } from "@playwright/test";

export async function omitAppApiPrefetch(
  page: Page,
  appUrl: string,
): Promise<void> {
  await page.route(`${appUrl}/**`, async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replaceAll(
        'data-okou-api-bootstrap=""',
        'data-okou-api-bootstrap-disabled=""',
      ),
    });
  });
}
