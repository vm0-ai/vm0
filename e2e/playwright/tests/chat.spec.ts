import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const MOBILE_VIEWPORT = { width: 402, height: 874 } as const;
const MOBILE_SAFE_BOTTOM_PX = 34;
const HOME_BOTTOM_GAP_PX = 48;
const CONNECTORS_BOTTOM_GAP_PX = 64;

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
});

test("mobile pages assign the bottom safe area to content and controls", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  const tagline = page.getByTestId("chat-tagline");
  await expect(tagline).toBeVisible({ timeout: 20_000 });

  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);

  const scrollViewport = page.locator("main").filter({ has: tagline });
  const scrollContent = page.getByTestId("agent-chat-scroll-content");
  const viewportBox = await scrollViewport.boundingBox();
  if (!viewportBox) {
    throw new Error("Expected visible chat safe-area geometry");
  }
  expect(viewportBox.y + viewportBox.height).toBeCloseTo(
    MOBILE_VIEWPORT.height,
    0,
  );
  await expect
    .poll(async () => {
      return scrollContent.evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).paddingBottom);
      });
    })
    .toBe(Math.max(HOME_BOTTOM_GAP_PX, MOBILE_SAFE_BOTTOM_PX));

  await page.evaluate(() => {
    document.documentElement.dataset.keyboardOpen = "true";
  });
  await page.getByRole("button", { name: "Open menu" }).click();

  const drawer = page.locator("aside.zero-mobile-sidebar");
  await expect(drawer).toBeVisible();
  const drawerMetrics = await drawer.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Expected the mobile drawer to be an element");
    }
    const rect = element.getBoundingClientRect();
    const controlBottoms = Array.from(
      element.querySelectorAll<HTMLElement>("a, button"),
    )
      .map((control) => {
        return control.getBoundingClientRect();
      })
      .filter((controlRect) => {
        return controlRect.width > 0 && controlRect.height > 0;
      })
      .map((controlRect) => {
        return controlRect.bottom;
      });
    if (controlBottoms.length === 0) {
      throw new Error("Expected visible controls in the mobile drawer");
    }
    return {
      bottom: rect.bottom,
      paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
      lastControlBottom: Math.max(...controlBottoms),
    };
  });

  expect(drawerMetrics.bottom).toBeCloseTo(MOBILE_VIEWPORT.height, 0);
  expect(drawerMetrics.paddingBottom).toBe(MOBILE_SAFE_BOTTOM_PX);
  expect(drawerMetrics.lastControlBottom).toBeLessThanOrEqual(
    MOBILE_VIEWPORT.height - MOBILE_SAFE_BOTTOM_PX,
  );

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.goto(new URL("/connectors", appUrl).href);
  const connectorsViewport = page.getByTestId("connectors-scroll-viewport");
  const connectorsContent = page.getByTestId("connectors-scroll-content");
  await expect(connectorsViewport).toBeVisible({ timeout: 20_000 });
  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);

  const connectorsViewportBox = await connectorsViewport.boundingBox();
  if (!connectorsViewportBox) {
    throw new Error("Expected visible connector safe-area geometry");
  }
  expect(connectorsViewportBox.y + connectorsViewportBox.height).toBeCloseTo(
    MOBILE_VIEWPORT.height,
    0,
  );
  await expect
    .poll(async () => {
      return connectorsContent.evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).paddingBottom);
      });
    })
    .toBe(Math.max(CONNECTORS_BOTTOM_GAP_PX, MOBILE_SAFE_BOTTOM_PX));
});

test("send a message through the deployed runner", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".zero-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf ${marker}`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toBeVisible({ timeout: 90_000 });
});
