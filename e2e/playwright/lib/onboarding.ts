import { expect, type Page } from "@playwright/test";

type AuthHeaders = Readonly<
  Record<"Authorization", string> &
    Partial<Record<"x-vercel-protection-bypass", string>>
>;

interface OnboardingFlowOptions {
  readonly appUrl: string;
}

export function authHeadersForToken(token: string): AuthHeaders {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return {
    Authorization: `Bearer ${token}`,
    ...(bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined),
  };
}

export async function completeExploreOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await openOnboarding(page, options);
  await submitExploreOnboarding(page);
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
  expect(new URL(page.url()).pathname).toBe("/onboarding/video-template");

  // The template pickers no longer pre-select a default, so a template must be
  // chosen before Continue becomes enabled.
  const videoTemplate = page
    .getByRole("button", { name: /video template$/iu })
    .first();
  await expect(videoTemplate).toBeVisible({ timeout: 30_000 });
  await videoTemplate.click();
  await expect(videoTemplate).toHaveAttribute("aria-pressed", "true");

  await clickOnboardingButton(page, /^Continue$/i);
  await expect(
    page.getByRole("heading", { name: /customize your video/i }),
  ).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/onboarding/video-run");

  await clickOnboardingButton(page, /^Upgrade Pro to run$/i);
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });
}

export async function waitForPaidOnboardingCompletion(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<URL> {
  const configuredAppOrigin = new URL(options.appUrl).origin;
  const deadline = Date.now() + 180_000;

  while (true) {
    const currentUrl = new URL(page.url());
    if (
      currentUrl.origin === configuredAppOrigin &&
      isPromptOrChatUrl(currentUrl)
    ) {
      return currentUrl;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for paid onboarding to complete in ${configuredAppOrigin}; current URL is ${page.url()}`,
      );
    }

    await page.waitForTimeout(Math.min(1_000, remainingMs));
  }
}

async function openOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await page.goto(new URL("/onboarding", options.appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).pathname).toBe("/onboarding");
}

async function submitExploreOnboarding(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeVisible({ timeout: 60_000 });
  await chooseMakeOption(page, "I will explore on my own");
  await clickOnboardingButton(page, /^Continue$/i);
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
  await page.waitForURL((url) => url.origin === appOrigin && isChatUrl(url), {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
}

function isChatUrl(url: URL): boolean {
  return /^\/(?:agents\/[^/]+\/chat|chats\/[^/]+)$/.test(url.pathname);
}

function isPromptOrChatUrl(url: URL): boolean {
  return url.pathname === "/prompt" || isChatUrl(url);
}
