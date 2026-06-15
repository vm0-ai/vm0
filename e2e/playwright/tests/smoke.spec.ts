import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";
import { fillStripeCheckout } from "../lib/stripe-checkout";

const TEST_OTP = "424242";

test("sign in and complete onboarding to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

  await clerkSetup();
  await setupClerkTestingToken({ page });

  // Navigate to app — redirects to www sign-in
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname.includes("/sign-in"), {
    timeout: 30_000,
  });

  // Sign in
  await signInWithEmailCode(
    page,
    email,
    redirectUrlFromAuthUrl(new URL(page.url())),
    60_000,
  );

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
  const requirePrSessionReuse = shouldRequirePrExternalOnboardingSessionReuse();

  while (Date.now() < deadline) {
    const url = new URL(page.url());
    if (isAuthUrl(url)) {
      if (requirePrSessionReuse) {
        await continueExternalOnboardingWithExistingSession(
          page,
          email,
          url.href,
          deadline,
        );
        continue;
      }

      const redirectUrl = redirectUrlFromAuthUrl(url);
      await signInWithEmailCode(
        page,
        email,
        redirectUrl,
        remainingTimeout(deadline, 60_000),
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

function shouldRequirePrExternalOnboardingSessionReuse(): boolean {
  return (process.env.JOB_REF ?? "").startsWith("pr-");
}

async function continueExternalOnboardingWithExistingSession(
  page: Page,
  email: string,
  currentHref: string,
  deadline: number,
): Promise<void> {
  const existingSession = page.locator("button").filter({ hasText: email });
  if (await waitForVisible(existingSession.first(), 5_000)) {
    await existingSession.first().click();
  } else {
    const identifierInput = page.locator('input[name="identifier"]').first();
    if (await waitForVisible(identifierInput, 5_000)) {
      await identifierInput.fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
    } else {
      const continueButton = page.getByRole("button", { name: "Continue" });
      if (await waitForVisible(continueButton, 5_000)) {
        await continueButton.click();
      }
    }
  }

  if (isOnboardingOrChatUrl(new URL(page.url()))) {
    return;
  }

  if (
    await waitForAuthOrOnboardingUrl(
      page,
      currentHref,
      remainingTimeout(deadline, 30_000),
    )
  ) {
    return;
  }

  throw new Error(
    `PR external onboarding did not reuse Clerk session: ${page.url()}`,
  );
}

async function signInWithEmailCode(
  page: Page,
  email: string,
  redirectUrl: string | null,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;

  await waitForVisible(
    page.locator('input[name="identifier"]').first(),
    remainingTimeout(deadline, 20_000),
  );
  await clickIfVisible(page.getByRole("button", { name: "Accept" }), 2_000);

  await page.locator('input[name="identifier"]').first().fill(email);
  await page.getByRole("button", { name: "Continue" }).click();

  const flow = await waitForEmailCodeFlow(
    page,
    remainingTimeout(deadline, 15_000),
  );
  if (flow === "alt") {
    await page
      .locator("a, button")
      .filter({ hasText: "Use another method" })
      .first()
      .click();
    await page
      .locator("button")
      .filter({ hasText: "Email code" })
      .first()
      .click();
  }

  await submitEmailCode(page, remainingTimeout(deadline, 30_000));

  if (redirectUrl && !isOnboardingOrChatUrl(new URL(page.url()))) {
    await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
  }
}

async function clickIfVisible(
  locator: Locator,
  timeout: number,
): Promise<void> {
  if (await waitForVisible(locator, timeout)) {
    await locator.click();
  }
}

async function waitForEmailCodeFlow(
  page: Page,
  timeout: number,
): Promise<"otp" | "alt"> {
  const result = await page.waitForFunction(
    () => {
      const hasOtp = Boolean(
        document.querySelector('input[data-input-otp="true"]'),
      );
      const hasAltMethod = Array.from(
        document.querySelectorAll("a, button"),
      ).some((element) => {
        return element.textContent?.includes("Use another method") ?? false;
      });

      if (hasOtp) {
        return "otp";
      }
      if (hasAltMethod) {
        return "alt";
      }
      return false;
    },
    undefined,
    { timeout },
  );
  const flow = await result.jsonValue();
  if (flow === "otp" || flow === "alt") {
    return flow;
  }
  throw new Error(`Unexpected Clerk sign-in flow: ${String(flow)}`);
}

async function submitEmailCode(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  const otpInput = page.locator('input[data-input-otp="true"]').first();
  await waitForVisible(otpInput, remainingTimeout(deadline, 15_000));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const navigation = waitForNonAuthUrl(
      page,
      remainingTimeout(deadline, 15_000),
    );
    await otpInput.click();
    await otpInput.type(TEST_OTP);

    if (await navigation) {
      return;
    }

    if (!isAuthUrl(new URL(page.url()))) {
      return;
    }

    await otpInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
  }

  throw new Error(`Authentication failed after OTP attempts: ${page.url()}`);
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

async function waitForNonAuthUrl(
  page: Page,
  timeout: number,
): Promise<boolean> {
  return await page
    .waitForURL((url) => !isAuthUrl(url), {
      timeout,
      waitUntil: "domcontentloaded",
    })
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
