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

  // Verify post-auth state: "Platform" button visible in navbar
  const platformButton = page.locator("a.btn-get-access:has-text('Platform')");
  await platformButton.waitFor({ state: "visible", timeout: 10_000 });

  // Verify Platform button links to the platform and opens in a new tab
  await expect(platformButton).toHaveAttribute("href", /platform/);
  await expect(platformButton).toHaveAttribute("target", "_blank");

  // Sign out
  const signOutButton = page.locator('button.btn-try-demo:has-text("Sign out")');
  await signOutButton.waitFor({ state: "visible", timeout: 10_000 });
  await signOutButton.click();

  // Verify signed out: sign-up button reappears
  await signUpLink.waitFor({ state: "visible", timeout: 10_000 });
});
