import { expect, type Page } from "@playwright/test";
import { deriveServiceOrigin } from "../playwright.config";
import { signInFromCurrentHostedAuthPage } from "./auth";
import { rewritePreviewAppFallbackUrl } from "./onboarding-handoff-url";

type AuthHeaders = Readonly<
  Record<"Authorization", string> &
    Partial<Record<"x-vercel-protection-bypass", string>>
>;

interface OnboardingAuthOptions {
  readonly email: string;
  readonly activeOrganizationId?: string;
}

interface OnboardingFlowOptions {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly onboardingUrl: string;
  readonly auth?: OnboardingAuthOptions;
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

export function deriveOnboardingUrl(apiUrl: string): string {
  return process.env.VM0_ONBOARDING_URL ?? deriveServiceOrigin(apiUrl, "www");
}

export async function completeExploreOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await openOnboarding(page, options);
  await submitExploreOnboarding(page);
  await waitForChatPage(page, options, async () => {
    await submitExploreOnboarding(page);
  });
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
  options: Pick<OnboardingFlowOptions, "appUrl" | "onboardingUrl" | "auth">,
): Promise<URL> {
  return await waitForPaidOnboardingHandoff(page, options, 180_000);
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

async function waitForChatPage(
  page: Page,
  options: Pick<OnboardingFlowOptions, "appUrl" | "onboardingUrl" | "auth">,
  continueAfterAuth: (() => Promise<void>) | undefined,
): Promise<void> {
  await waitForOnboardingHandoff(
    page,
    options,
    isChatUrl,
    120_000,
    continueAfterAuth,
  );
}

async function waitForOnboardingHandoff(
  page: Page,
  options: Pick<OnboardingFlowOptions, "appUrl" | "onboardingUrl" | "auth">,
  isTargetUrl: (url: URL) => boolean,
  timeout: number,
  continueAfterAuth?: () => Promise<void>,
): Promise<URL> {
  const configuredAppOrigin = new URL(options.appUrl).origin;
  const onboardingOrigin = new URL(options.onboardingUrl).origin;
  const isExpectedTargetUrl = (url: URL) =>
    url.origin === configuredAppOrigin && isTargetUrl(url);
  await waitForExpectedUrl(
    page,
    configuredAppOrigin,
    onboardingOrigin,
    (url) => isExpectedTargetUrl(url) || isHostedSignInUrl(url),
    timeout,
  );

  const currentUrl = new URL(page.url());
  if (isExpectedTargetUrl(currentUrl)) {
    return currentUrl;
  }

  if (!options.auth) {
    throw new Error(
      `Onboarding handoff required sign-in at ${currentUrl.origin}, but no auth options were provided`,
    );
  }

  await signInFromCurrentHostedAuthPage(page, options.auth.email, {
    activeOrganizationId: options.auth.activeOrganizationId,
  });
  await waitForExpectedUrl(
    page,
    configuredAppOrigin,
    onboardingOrigin,
    (url) => isExpectedTargetUrl(url) || isOnboardingUrl(url),
    timeout,
  );
  const postAuthUrl = new URL(page.url());
  if (isExpectedTargetUrl(postAuthUrl)) {
    return postAuthUrl;
  }

  if (!continueAfterAuth) {
    throw new Error(
      `Onboarding handoff returned to ${postAuthUrl.origin}${postAuthUrl.pathname} after sign-in`,
    );
  }

  await continueAfterAuth();
  await waitForExpectedUrl(
    page,
    configuredAppOrigin,
    onboardingOrigin,
    isExpectedTargetUrl,
    timeout,
  );
  return new URL(page.url());
}

function onboardingEntryUrl(options: OnboardingFlowOptions): string {
  const url = new URL("/onboarding/491858", options.onboardingUrl);
  url.searchParams.set("domain", new URL(options.apiUrl).host);
  url.searchParams.set("vm0_theme", "light");
  return url.toString();
}

type UrlMatcher = (url: URL) => boolean;

async function waitForExpectedUrl(
  page: Page,
  appOrigin: string,
  onboardingOrigin: string,
  matchesExpectedUrl: UrlMatcher,
  timeoutMs: number,
): Promise<URL> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const currentUrl = new URL(page.url());
    const rewrittenUrl = rewritePreviewAppFallbackUrl(
      currentUrl,
      appOrigin,
      onboardingOrigin,
    );
    if (rewrittenUrl) {
      console.log("[e2e] rewriting onboarding preview handoff", {
        from: currentUrl.toString(),
        to: rewrittenUrl,
      });
      await page.goto(rewrittenUrl, { waitUntil: "domcontentloaded" });
      continue;
    }

    if (matchesExpectedUrl(currentUrl)) {
      return currentUrl;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for onboarding app handoff to ${appOrigin}; current URL is ${page.url()}`,
      );
    }

    await page.waitForURL(
      (url) =>
        matchesExpectedUrl(url) ||
        rewritePreviewAppFallbackUrl(url, appOrigin, onboardingOrigin) !== null,
      { timeout: remainingMs, waitUntil: "domcontentloaded" },
    );
  }
}

function isChatUrl(url: URL): boolean {
  return /\/agents\/[^/]+\/chat/.test(url.pathname);
}

function isPromptOrChatUrl(url: URL): boolean {
  return url.pathname === "/prompt" || isChatUrl(url);
}

function isHostedSignInUrl(url: URL): boolean {
  return url.pathname.includes("/sign-in");
}

function isOnboardingUrl(url: URL): boolean {
  return url.pathname.startsWith("/onboarding/");
}

async function waitForPaidOnboardingHandoff(
  page: Page,
  options: Pick<OnboardingFlowOptions, "appUrl" | "onboardingUrl" | "auth">,
  timeout: number,
): Promise<URL> {
  const configuredAppOrigin = new URL(options.appUrl).origin;
  const onboardingOrigin = new URL(options.onboardingUrl).origin;
  const deadline = Date.now() + timeout;
  let nextBillingReturnReloadAt: number | null = null;

  while (true) {
    const currentUrl = new URL(page.url());
    const rewrittenUrl = rewritePreviewAppFallbackUrl(
      currentUrl,
      configuredAppOrigin,
      onboardingOrigin,
    );
    if (rewrittenUrl) {
      console.log("[e2e] rewriting paid onboarding preview handoff", {
        from: currentUrl.toString(),
        to: rewrittenUrl,
      });
      await page.goto(rewrittenUrl, { waitUntil: "domcontentloaded" });
      continue;
    }

    if (
      currentUrl.origin === configuredAppOrigin &&
      isPromptOrChatUrl(currentUrl)
    ) {
      return currentUrl;
    }

    const checkoutSessionId = paidBillingSessionId(currentUrl);
    if (checkoutSessionId !== null && isOnboardingUrl(currentUrl)) {
      const now = Date.now();
      nextBillingReturnReloadAt ??= now + 15_000;
      if (now >= nextBillingReturnReloadAt) {
        console.log("[e2e] reloading paid onboarding return page", {
          url: currentUrl.toString(),
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        nextBillingReturnReloadAt = now + 15_000;
      }
    }

    if (isHostedSignInUrl(currentUrl)) {
      if (!options.auth) {
        throw new Error(
          `Paid onboarding handoff required sign-in at ${currentUrl.origin}, but no auth options were provided`,
        );
      }
      await signInFromCurrentHostedAuthPage(page, options.auth.email, {
        activeOrganizationId: options.auth.activeOrganizationId,
      });
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for paid onboarding handoff to ${configuredAppOrigin}; current URL is ${page.url()}`,
      );
    }

    await page.waitForTimeout(Math.min(1_000, remainingMs));
  }
}

function paidBillingSessionId(url: URL): string | null {
  if (url.searchParams.get("billing") !== "pro") {
    return null;
  }
  const sessionId = url.searchParams.get("billing_session_id");
  if (!sessionId || sessionId === "{CHECKOUT_SESSION_ID}") {
    return null;
  }
  return sessionId;
}
