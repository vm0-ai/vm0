import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  authV2Root,
  expectStepAnnouncement,
  openAuthV2,
  reloadAuthV2,
} from "../lib/auth-v2-ui";

const AUTH_V2_PRIMARY_BACKGROUND_COLOR = "rgb(239, 80, 1)";
const UNSUPPORTED_CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/110.0.0.0 Safari/537.36";

function relativeLuminance(color: string): number {
  const channels = color
    .match(/[0-9.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (
    channels?.length !== 3 ||
    channels.some((channel) => !Number.isFinite(channel))
  ) {
    throw new Error(`Expected an RGB color, received ${color}`);
  }
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

async function renderedLinkContrast(
  linkAction: Locator,
  surface: Locator,
): Promise<number> {
  const linkForeground = await linkAction.evaluate((element) => {
    return getComputedStyle(element).color;
  });
  const surfaceBackground = await surface.evaluate((element) => {
    return getComputedStyle(element).backgroundColor;
  });
  return contrastRatio(linkForeground, surfaceBackground);
}

async function expectAccessibleLinkContrast(
  linkAction: Locator,
  surface: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      return renderedLinkContrast(linkAction, surface);
    })
    .toBeGreaterThanOrEqual(4.5);
}

test("stable auth routes render Auth v2 on desktop", async ({
  page,
}) => {
  const stableRoutes = [
    "/sign-in",
    "/sign-in/factor-one?auth_v2_e2e=nested#/factor-one",
    "/sign-up",
    "/sign-up/verify-email-address?auth_v2_e2e=nested#/verify",
  ];
  for (const route of stableRoutes) {
    await openAuthV2(page, route);
    const expectedPathname = new URL(route, "https://auth-v2.invalid").pathname;
    expect(new URL(page.url()).pathname).toBe(expectedPathname);
    await reloadAuthV2(page);
    expect(new URL(page.url()).pathname).toBe(expectedPathname);
  }

  expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(
    1_000,
  );
});

test("primary actions retain brand styling while links remain accessible", async ({
  page,
}) => {
  await openAuthV2(page, "/sign-up");

  const root = authV2Root(page);
  const continueButton = root.getByRole("button", {
    exact: true,
    name: "Continue",
  });
  const signInLink = root.getByRole("link", {
    exact: true,
    name: "Sign in",
  });
  const passwordVisibilityAction = root.getByRole("button", {
    name: "Show password",
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(continueButton).toHaveCSS(
    "background-color",
    AUTH_V2_PRIMARY_BACKGROUND_COLOR,
  );
  await expect(continueButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(continueButton).toHaveClass(/\bbg-primary\b/);
  await expect(continueButton).toHaveClass(/\btext-primary-foreground\b/);
  await expect(signInLink).toHaveClass(/\btext-primary-900\b/);
  await expectAccessibleLinkContrast(signInLink, root);
  await expect(passwordVisibilityAction).toHaveCSS("color", "rgb(21, 24, 30)");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(continueButton).toHaveCSS(
    "background-color",
    AUTH_V2_PRIMARY_BACKGROUND_COLOR,
  );
  await expect(continueButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expectAccessibleLinkContrast(signInLink, root);
  await expect(passwordVisibilityAction).toHaveCSS(
    "color",
    "rgb(233, 234, 236)",
  );
});

test.describe("English startup in a non-English browser", () => {
  test.use({
    colorScheme: "dark",
    locale: "fr-FR",
    viewport: { height: 844, width: 390 },
  });

  test("keeps brand, theme, focus, announcements, and layout accessible", async ({
    page,
  }) => {
    await openAuthV2(
      page,
      "/sign-in/factor-one?auth_v2_e2e=mobile#/factor-one",
    );

    const heading = authV2Root(page).locator("h1");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(/Okou|VM0/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(heading).toBeFocused();
    await expectStepAnnouncement(page);

    const themeToggle = page.getByRole("button", {
      name: /theme|thème/i,
    });
    await expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    await themeToggle.focus();
    await page.keyboard.press("Enter");
    await expect(themeToggle).toBeFocused();
    await expect(themeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });

  test("loads English platform-owned sign-up copy", async ({ page }) => {
    await openAuthV2(page, "/sign-up/verify-email-address");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(authV2Root(page).locator("h1")).toHaveText(
      "Create your account",
    );
  });
});

test.describe("unsupported browser", () => {
  test.use({ userAgent: UNSUPPORTED_CHROME_USER_AGENT });

  test("shows the English browser upgrade page", async ({ page }) => {
    await page.goto("/sign-up", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Update Chrome to continue" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Update Chrome" })).toHaveAttribute(
      "href",
      "https://www.google.com/chrome/",
    );
  });

  test("preserves the upgrade page for browser history restoration", async ({
    page,
  }) => {
    await page.goto("/sign-up", { waitUntil: "domcontentloaded" });
    const heading = page.getByRole("heading", {
      name: "Update Chrome to continue",
    });
    await expect(heading).toBeVisible();

    // Exercise the persisted lifecycle explicitly so coverage does not depend
    // on the test browser accepting this page into BFCache.
    await page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });

    await expect(heading).toBeVisible();
  });
});
