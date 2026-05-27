import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
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

async function completeOnboarding(page: import("@playwright/test").Page) {
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
