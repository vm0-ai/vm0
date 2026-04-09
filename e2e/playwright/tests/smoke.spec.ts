import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("sign in and complete onboarding to chat page", async ({ page }) => {
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
    timeout: 60_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });
});

async function completeOnboarding(page: import("@playwright/test").Page) {
  const workspaceInput = page.getByPlaceholder("e.g. Acme Corp");
  if (await workspaceInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await workspaceInput.fill("E2E Test Workspace");
    await page.getByRole("button", { name: "Next" }).click();
  }

  const chooseTools = page.getByTestId("onboarding-step-select-connectors");
  if (await chooseTools.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.getByRole("button", { name: "Next" }).click();
  }

  const connectApps = page.getByTestId("onboarding-step-connect");
  if (await connectApps.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.getByRole("button", { name: "Next" }).click();
  }

  const whereToWork = page.getByTestId("onboarding-step-where-to-work");
  if (await whereToWork.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.getByRole("button", { name: "Continue in web" }).click();
  }
}
