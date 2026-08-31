import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  authV2Root,
  expectStepAnnouncement,
  openAuthV2,
  reloadAuthV2,
} from "../lib/auth-v2-ui";

const AUTH_V2_PRIMARY_BACKGROUND_COLOR = "rgb(239, 80, 1)";
const SUPPORTED_AUTH_V2_LOCALES = [
  { locale: "en-US", title: "Create your account" },
  { locale: "pt-BR", title: "Criar sua conta" },
  { locale: "ja-JP", title: "アカウントを作成" },
  { locale: "ko-KR", title: "계정 만들기" },
  { locale: "id-ID", title: "Buat akun Anda" },
  { locale: "de-DE", title: "Ihr Konto erstellen" },
  { locale: "es-ES", title: "Crea tu cuenta" },
  { locale: "it-IT", title: "Crea il tuo account" },
  { locale: "fr-FR", title: "Créer votre compte" },
  { locale: "hi-IN", title: "अपना खाता बनाएं" },
] as const;

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

test.describe("localized mobile presentation", () => {
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
    await expect(heading).not.toHaveText(/^Sign in to (Okou|VM0)$/);
    await expect(page.locator("html")).toHaveAttribute("lang", /^fr/i);
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
});

for (const { locale, title } of SUPPORTED_AUTH_V2_LOCALES) {
  test.describe(`Auth v2 locale ${locale}`, () => {
    test.use({ locale });

    test("loads platform-owned sign-up copy", async ({ page }) => {
      await openAuthV2(page, "/sign-up/verify-email-address");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const heading = authV2Root(page).locator("h1");
      await expect(heading).toHaveText(title);
    });
  });
}
