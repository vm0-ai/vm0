import { expect, type Page } from "@playwright/test";
import { deriveServiceOrigin } from "../playwright.config";

type AuthHeaders = Readonly<Record<"Authorization", string>>;

interface OnboardingFlowOptions {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly onboardingUrl: string;
}

export function authHeadersForToken(token: string): AuthHeaders {
  return { Authorization: `Bearer ${token}` };
}

export function deriveOnboardingUrl(apiUrl: string): string {
  return process.env.VM0_ONBOARDING_URL ?? deriveServiceOrigin(apiUrl, "www");
}

export async function completeExploreOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await openOnboarding(page, options);
  await chooseMakeOption(page, "I will explore on my own");
  await clickOnboardingButton(page, /^Continue$/i);
  await waitForChatPage(page, options.appUrl);
}

export async function startVideoOnboardingCheckout(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await openOnboarding(page, options);
  await chooseMakeOption(page, "Video production");
  await clickOnboardingButton(page, /^Continue$/i);
  await expect(
    page.getByRole("heading", {
      name: /pick a video template to start from/i,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await clickOnboardingButton(page, /^Continue$/i);
  await expect(
    page.getByRole("heading", { name: /customize your video/i }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await clickOnboardingButton(page, /^Upgrade Pro to run$/i);
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });
}

export async function waitForPaidOnboardingAppHandoff(
  page: Page,
  appUrl: string,
): Promise<void> {
  const appOrigin = new URL(appUrl).origin;
  await page.waitForURL(
    (url) => {
      return (
        url.origin === appOrigin &&
        (url.pathname === "/prompt" ||
          /\/agents\/[^/]+\/chat/.test(url.pathname))
      );
    },
    { timeout: 180_000, waitUntil: "domcontentloaded" },
  );
}

async function openOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await page.goto(onboardingEntryUrl(options), {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeVisible({ timeout: 60_000 });
}

async function chooseMakeOption(page: Page, name: string): Promise<void> {
  await page.getByRole("radio", { name }).click();
  await expect(page.getByRole("radio", { name })).toHaveAttribute(
    "aria-checked",
    "true",
  );
}

async function clickOnboardingButton(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole("button", { name }).last();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
}

async function waitForChatPage(page: Page, appUrl: string): Promise<void> {
  const appOrigin = new URL(appUrl).origin;
  await page.waitForURL(
    (url) => {
      return (
        url.origin === appOrigin && /\/agents\/[^/]+\/chat/.test(url.pathname)
      );
    },
    { timeout: 120_000, waitUntil: "domcontentloaded" },
  );
}

function onboardingEntryUrl(options: OnboardingFlowOptions): string {
  const url = new URL("/onboarding/491858", options.onboardingUrl);
  url.searchParams.set("domain", new URL(options.apiUrl).host);
  url.searchParams.set("vm0_theme", "light");
  return url.toString();
}
