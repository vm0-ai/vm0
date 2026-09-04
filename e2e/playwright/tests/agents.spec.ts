import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test("navigate to agents page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });
});

test.describe("pinned-agent loading transition", () => {
  test.use({
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 900 },
  });

  test("keeps the label frame on the same device pixels", async ({ page }) => {
    let releasePreferences = () => {};
    const preferencesGate = new Promise<void>((resolve) => {
      releasePreferences = resolve;
    });

    await page.route("**/api/user-preferences", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await preferencesGate;
      await route.continue();
    });

    try {
      await page.goto(appUrl, { waitUntil: "domcontentloaded" });

      const loadingLabel = page.getByTestId("pinned-agent-label-frame");
      await expect(loadingLabel).toBeVisible({ timeout: 20_000 });
      const loadingBox = await loadingLabel.boundingBox();
      if (!loadingBox) {
        throw new Error("Pinned-agent loading label has no rendered bounds");
      }
      const devicePixelRatio = await page.evaluate(() => {
        return window.devicePixelRatio;
      });
      expect(loadingBox.height * devicePixelRatio).toBe(28);

      releasePreferences();

      const resolvedLabel = page
        .getByTestId("pinned-agent-card")
        .first()
        .getByTestId("pinned-agent-label-frame");
      await expect(resolvedLabel).toBeVisible({ timeout: 20_000 });
      const resolvedBox = await resolvedLabel.boundingBox();
      if (!resolvedBox) {
        throw new Error("Pinned-agent resolved label has no rendered bounds");
      }

      expect(resolvedBox.y).toBe(loadingBox.y);
      expect(resolvedBox.height * devicePixelRatio).toBe(28);
    } finally {
      releasePreferences();
    }
  });
});
