import { expect, type Page } from "@playwright/test";
import { deriveServiceOrigin } from "../playwright.config";
import { signInFromCurrentHostedAuthPage } from "./auth";

type AuthHeaders = Readonly<Record<"Authorization", string>>;

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
  options: Pick<OnboardingFlowOptions, "appUrl" | "auth">,
): Promise<URL> {
  return await waitForOnboardingHandoff(
    page,
    options,
    isPromptOrChatUrl,
    180_000,
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
  options: Pick<OnboardingFlowOptions, "appUrl" | "auth">,
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
  options: Pick<OnboardingFlowOptions, "appUrl" | "auth">,
  isTargetUrl: (url: URL) => boolean,
  timeout: number,
  continueAfterAuth?: () => Promise<void>,
): Promise<URL> {
  const configuredAppOrigin = new URL(options.appUrl).origin;
  await waitForExpectedUrl(
    page,
    configuredAppOrigin,
    (url) =>
      (url.origin === configuredAppOrigin && isTargetUrl(url)) ||
      isHostedSignInUrl(url),
    timeout,
  );

  const currentUrl = new URL(page.url());
  if (isTargetUrl(currentUrl)) {
    return currentUrl;
  }

  if (!options.auth) {
    throw new Error(
      `Onboarding handoff required sign-in at ${currentUrl.origin}, but no auth options were provided`,
    );
  }

  const redirectOrigin = redirectOriginFromAuthUrl(currentUrl);
  await signInFromCurrentHostedAuthPage(page, options.auth.email, {
    activeOrganizationId: options.auth.activeOrganizationId,
  });
  const isAllowedTargetUrl = (url: URL) => {
    return (
      isTargetUrl(url) &&
      (url.origin === configuredAppOrigin ||
        url.origin === redirectOrigin ||
        redirectOrigin === null)
    );
  };
  await waitForExpectedUrl(
    page,
    configuredAppOrigin,
    (url) => isAllowedTargetUrl(url) || isOnboardingUrl(url),
    timeout,
  );
  const postAuthUrl = new URL(page.url());
  if (isAllowedTargetUrl(postAuthUrl)) {
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
    isAllowedTargetUrl,
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
  matchesExpectedUrl: UrlMatcher,
  timeoutMs: number,
): Promise<URL> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const currentUrl = new URL(page.url());
    const rewrittenUrl = rewritePreviewAppFallbackUrl(currentUrl, appOrigin);
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
        rewritePreviewAppFallbackUrl(url, appOrigin) !== null,
      { timeout: remainingMs, waitUntil: "domcontentloaded" },
    );
  }
}

function rewritePreviewAppFallbackUrl(
  url: URL,
  appOrigin: string,
): string | null {
  const rewrittenUrl = withExpectedPreviewAppOrigin(url, appOrigin);
  if (!rewrittenUrl) {
    return null;
  }

  rewriteNestedRedirectUrl(rewrittenUrl, appOrigin);
  return rewrittenUrl.toString();
}

function withExpectedPreviewAppOrigin(url: URL, appOrigin: string): URL | null {
  if (!isPreviewAppStagingFallback(url, appOrigin)) {
    return null;
  }

  const appUrl = new URL(appOrigin);
  const rewrittenUrl = new URL(url.toString());
  rewrittenUrl.protocol = appUrl.protocol;
  rewrittenUrl.host = appUrl.host;
  return rewrittenUrl;
}

function isPreviewAppStagingFallback(url: URL, appOrigin: string): boolean {
  const appUrl = new URL(appOrigin);
  const previewDomainMatch = /^pr-\d+-app\.(.+)$/.exec(appUrl.hostname);
  if (!previewDomainMatch) {
    return false;
  }

  return (
    url.protocol === appUrl.protocol &&
    url.hostname === `staging-app.${previewDomainMatch[1]}`
  );
}

function rewriteNestedRedirectUrl(url: URL, appOrigin: string): void {
  const redirectUrl = url.searchParams.get("redirect_url");
  if (!redirectUrl) {
    return;
  }

  try {
    const rewrittenRedirectUrl = withExpectedPreviewAppOrigin(
      new URL(redirectUrl),
      appOrigin,
    );
    if (rewrittenRedirectUrl) {
      url.searchParams.set("redirect_url", rewrittenRedirectUrl.toString());
    }
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
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

function redirectOriginFromAuthUrl(url: URL): string | null {
  const redirectUrl = url.searchParams.get("redirect_url");
  return redirectUrl ? new URL(redirectUrl).origin : null;
}
