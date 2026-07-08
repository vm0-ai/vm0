import { expect, test as base } from "@playwright/test";

export { expect };

export const test = base.extend({
  context: async ({ context }, use) => {
    const apiUrl = process.env.VM0_API_URL;
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
