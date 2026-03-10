import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const TEST_EMAIL = "e2e+clerk_test@vm0.ai";
const TEST_OTP = "424242";

test("sign-in flow", async ({ page, baseURL }) => {
  await setupClerkTestingToken({ page });

  // Handle Vercel protection bypass if needed
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    await page.goto(
      `${baseURL}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`
    );
  }

  // Navigate to landing page and click sign-up in navbar to start auth flow
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  const signUpLink = page.locator("a.btn-get-access[href='/sign-up']");
  await signUpLink.waitFor({ state: "visible", timeout: 10_000 });
  await signUpLink.click();
  await page.waitForURL("**/sign-up**");

  // Switch to sign-in (test account already exists)
  const signInLink = page.locator('a:has-text("Sign in")');
  await signInLink.waitFor({ state: "visible", timeout: 10_000 });
  await signInLink.click();
  await page.waitForURL("**/sign-in**");

  // Enter email
  const emailInput = page.locator('input[name="identifier"]');
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });
  await emailInput.fill(TEST_EMAIL);

  await page.locator(".cl-formButtonPrimary").click();

  // Switch to email code method
  const useAnotherMethod = page.locator(
    'a:has-text("Use another method"), button:has-text("Use another method")'
  );
  await useAnotherMethod.waitFor({ state: "visible", timeout: 10_000 });
  await useAnotherMethod.click();

  const emailCodeOption = page.locator('button:has-text("Email code")');
  await emailCodeOption.waitFor({ state: "visible", timeout: 10_000 });
  await emailCodeOption.click();

  // Enter OTP with retry — Clerk needs time to prepare the verification session
  const otpInput = page.locator('input[data-input-otp="true"]');
  await expect(otpInput).toBeEditable({ timeout: 10_000 });
  await expect(async () => {
    await otpInput.fill(TEST_OTP);
    await expect(page).not.toHaveURL(/sign-in/, { timeout: 5_000 });
  }).toPass({ intervals: [1_000, 2_000], timeout: 15_000 });
  expect(page.url()).not.toContain("/404");

  // After sign-in, Clerk redirects to the platform (signInFallbackRedirectUrl)
  // or keeps the user on the web app. Verify the user is authenticated by
  // checking for either: redirect to platform URL, or the Platform button in navbar.
  await expect(async () => {
    const url = page.url();
    const onPlatform = /platform/.test(url);
    const onWebApp = !onPlatform;
    if (onWebApp) {
      // Still on web app — the Platform button should be visible for authenticated users
      const platformButton = page.locator("a.btn-get-access:has-text('Platform')");
      await expect(platformButton).toBeVisible({ timeout: 2_000 });
    }
    // If on platform, authentication succeeded and redirect worked
    expect(onPlatform || onWebApp).toBe(true);
  }).toPass({ intervals: [1_000, 2_000], timeout: 15_000 });

  // Navigate back to web app to test sign-out
  await page.goto(baseURL ?? "/");
  await page.waitForLoadState("domcontentloaded");

  // Sign out
  const signOutButton = page.locator('button.btn-try-demo:has-text("Sign out")');
  await signOutButton.waitFor({ state: "visible", timeout: 10_000 });
  await signOutButton.click();

  // Verify signed out: sign-up button reappears
  await signUpLink.waitFor({ state: "visible", timeout: 10_000 });
});
