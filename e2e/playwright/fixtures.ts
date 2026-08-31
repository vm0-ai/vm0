import { expect, test as base } from "@playwright/test";

import { seedPreviewBypassCookie } from "./lib/preview-bypass";

interface PreviewBypassFixtures {
  readonly previewBypassCookie: void;
}

const test = base.extend<PreviewBypassFixtures>({
  previewBypassCookie: [
    async ({ baseURL, context }, use) => {
      if (!baseURL) {
        throw new Error("Playwright baseURL is required");
      }
      await seedPreviewBypassCookie(context, baseURL);
      await use();
    },
    { auto: true },
  ],
});

export { expect, test };
