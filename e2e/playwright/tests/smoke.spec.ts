import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";
import { fillStripeCheckout } from "../lib/stripe-checkout";

test("sign in and complete onboarding to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

  await clerkSetup();

  // Navigate to app — redirects to www sign-in
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname.includes("/sign-in"), {
    timeout: 30_000,
  });

  // Sign in
  await clerk.signIn({ page, emailAddress: email });

  // Navigate to app — should land on onboarding or agents
  await page.goto(appUrl);
  await page.waitForURL(
    (url) => {
      const p = url.pathname;
      return p.includes("/onboarding") || p.includes("/agents/");
    },
    { timeout: 30_000 },
  );

  // Complete onboarding if needed
  if (page.url().includes("/onboarding")) {
    await signInThroughExternalOnboardingGate(page, email);
    await completeOnboarding(page);
  }

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });
});

async function signInThroughExternalOnboardingGate(
  page: Page,
  email: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const url = new URL(page.url());
    if (isAuthUrl(url)) {
      const redirectUrl = redirectUrlFromAuthUrl(url);
      const currentHref = url.href;
      await clerk.signIn({ page, emailAddress: email });
      if (redirectUrl && !isOnboardingOrChatUrl(new URL(page.url()))) {
        await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
      }
      await waitForAuthOrOnboardingUrl(
        page,
        currentHref,
        remainingTimeout(deadline, 30_000),
      );
      continue;
    }

    if (isChatUrl(url)) {
      return;
    }

    const continueToSignUp = page.getByRole("link", {
      name: "Continue to sign up",
    });
    if (
      await waitForVisible(continueToSignUp, remainingTimeout(deadline, 2_000))
    ) {
      await continueToSignUp.click();
      await waitForAuthOrOnboardingUrl(
        page,
        url.href,
        remainingTimeout(deadline, 30_000),
      );
      continue;
    }

    if (url.pathname.includes("/onboarding")) {
      if (
        await waitForOnboardingStep(page, remainingTimeout(deadline, 5_000))
      ) {
        return;
      }

      if (await waitForAuthUrl(page, remainingTimeout(deadline, 10_000))) {
        continue;
      }

      continue;
    }

    await waitForAuthOrOnboardingUrl(
      page,
      url.href,
      remainingTimeout(deadline, 5_000),
    );
  }

  throw new Error(
    `Unable to complete external onboarding sign-in: ${page.url()}`,
  );
}

async function waitForVisible(
  locator: Locator,
  timeout: number,
): Promise<boolean> {
  return await locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForOnboardingStep(
  page: Page,
  timeout: number,
): Promise<boolean> {
  const visibleChecks = [
    page.getByPlaceholder("e.g. Acme Corp"),
    page.getByTestId("onboarding-step-select-connectors"),
    page.getByTestId("onboarding-step-trial"),
  ].map((locator) => locator.waitFor({ state: "visible", timeout }));

  return await Promise.any(visibleChecks)
    .then(() => true)
    .catch(() => false);
}

async function waitForAuthOrOnboardingUrl(
  page: Page,
  currentHref: string,
  timeout: number,
): Promise<boolean> {
  return await page
    .waitForURL(
      (url) => {
        return (
          url.href !== currentHref &&
          (isAuthUrl(url) || isOnboardingOrChatUrl(url))
        );
      },
      { timeout, waitUntil: "domcontentloaded" },
    )
    .then(() => true)
    .catch(() => false);
}

function remainingTimeout(deadline: number, maxTimeout: number): number {
  return Math.max(1, Math.min(maxTimeout, deadline - Date.now()));
}

async function waitForAuthUrl(page: Page, timeout: number): Promise<boolean> {
  return await page
    .waitForURL(isAuthUrl, {
      timeout,
      waitUntil: "domcontentloaded",
    })
    .then(() => true)
    .catch(() => false);
}

function isAuthUrl(url: URL): boolean {
  return url.pathname.includes("/sign-up") || url.pathname.includes("/sign-in");
}

function isChatUrl(url: URL): boolean {
  return /\/agents\/.*\/chat/.test(url.pathname);
}

function redirectUrlFromAuthUrl(url: URL): string | null {
  const searchRedirect = url.searchParams.get("redirect_url");
  if (searchRedirect) {
    return searchRedirect;
  }

  const hashQueryStart = url.hash.indexOf("?");
  if (hashQueryStart === -1) {
    return null;
  }

  return new URLSearchParams(url.hash.slice(hashQueryStart + 1)).get(
    "redirect_url",
  );
}

function isOnboardingOrChatUrl(url: URL): boolean {
  return url.pathname.includes("/onboarding") || isChatUrl(url);
}

async function completeOnboarding(page: Page) {
  // NOTE: Playwright's locator.isVisible() returns the *current* visibility
  // synchronously — the `timeout` option only controls element resolution,
  // not visibility polling. waitFor({ state: "visible" }) does the real wait
  // and is what we need here, because the step 1 → step 2 transition runs
  // an async eager-init API call before the next step renders.
  const tryAwaitVisible = async (
    locator: ReturnType<typeof page.locator>,
    timeout: number,
  ): Promise<boolean> => {
    return await locator
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);
  };

  // Step 1: name the workspace (eager-inits the workspace + default agent).
  const workspaceInput = page.getByPlaceholder("e.g. Acme Corp");
  if (await tryAwaitVisible(workspaceInput, 5_000)) {
    await workspaceInput.fill("E2E Test Workspace");
    await page.getByRole("button", { name: "Next" }).click();
  }

  // Step 2: choose tools. The step 1 → step 2 transition runs the eager-init
  // API, so allow plenty of time.
  const chooseTools = page.getByTestId("onboarding-step-select-connectors");
  if (await tryAwaitVisible(chooseTools, 15_000)) {
    await page.getByRole("button", { name: "Next" }).click();
  }

  // Step 3: start the Pro trial. Stripe redirects back to onboarding; once the
  // webhook clears onboardingPaymentPending, the app redirects to the chat page.
  const trialStep = page.getByTestId("onboarding-step-trial");
  if (await tryAwaitVisible(trialStep, 15_000)) {
    await page.getByRole("button", { name: "Get Started" }).click();
    await fillStripeCheckout(page);
  }
}
