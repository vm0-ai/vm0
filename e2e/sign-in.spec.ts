import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const TEST_EMAIL = "e2e+clerk_test@vm0.ai";
const TEST_OTP = "424242";

test("sign-up flow and post-auth landing page", async ({ page, baseURL }) => {
  await setupClerkTestingToken({ page });

  // Handle Vercel protection bypass if needed
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    await page.goto(
      `${baseURL}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`
    );
  }

  // Navigate to landing page
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  // Click the sign-up button in the navbar.
  // This verifies the link goes to /sign-up (not /en/sign-up which would 404).
  const signUpLink = page.locator("a.btn-get-access[href='/sign-up']");
  await signUpLink.waitFor({ state: "visible", timeout: 10_000 });
  await signUpLink.click();

  // Verify we landed on /sign-up (not a locale-prefixed path)
  await page.waitForURL("**/sign-up**");
  expect(new URL(page.url()).pathname).toBe("/sign-up");

  // The sign-up page renders Clerk's <SignUp> component.
  // Since the test account already exists, click "Sign in" to switch to sign-in flow.
  const signInLink = page.locator('a:has-text("Sign in")');
  await signInLink.waitFor({ state: "visible", timeout: 10_000 });
  await signInLink.click();
  await page.waitForURL("**/sign-in**");

  // Complete Clerk sign-in via UI
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

  // Enter OTP
  const otpInput = page.locator('input[data-input-otp="true"]');
  await otpInput.waitFor({ state: "attached", timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await otpInput.focus();
  await page.keyboard.type(TEST_OTP);

  // Wait for redirect away from /sign-in back to landing page
  await page.waitForURL(
    (url) =>
      !url.pathname.includes("/sign-in") &&
      !url.pathname.includes("/sign-up"),
    { timeout: 15_000 }
  );
  expect(page.url()).not.toContain("/404");

  // Verify post-auth state: "Platform" button visible in navbar
  const platformButton = page.locator("a.btn-get-access:has-text('Platform')");
  await platformButton.waitFor({ state: "visible", timeout: 10_000 });

  // Verify Platform button opens new tab to platform URL
  const [newPage] = await Promise.all([
    page.context().waitForEvent("page"),
    platformButton.click(),
  ]);
  await newPage.waitForLoadState("domcontentloaded");
  expect(newPage.url()).toContain("platform");
  await newPage.close();

  // Sign out (cleanup) — target the desktop nav button specifically
  const signOutButton = page.locator('button.btn-try-demo:has-text("Sign out")');
  await signOutButton.waitFor({ state: "visible", timeout: 10_000 });
  await signOutButton.click();

  // Verify we're signed out: sign-up button reappears
  await signUpLink.waitFor({ state: "visible", timeout: 10_000 });
});
