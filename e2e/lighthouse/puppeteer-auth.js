/**
 * Puppeteer script for Lighthouse CI platform authentication.
 *
 * Performs Clerk sign-in via email + OTP so that Lighthouse collections
 * run against an authenticated session.
 *
 * Contract: module.exports = async (browser, context) => { ... }
 * Do NOT close the browser — LHCI manages the lifecycle.
 *
 * Environment variables:
 *   WEB_URL                          – Web app origin (for sign-in flow)
 *   PLATFORM_URL                     – Platform app origin (audit target)
 *   VERCEL_AUTOMATION_BYPASS_SECRET  – Vercel protection bypass token
 */

const TEST_EMAIL = "e2e+clerk_test@vm0.ai";
const TEST_OTP = "424242";

/** Wait for a selector to appear and return the element handle. */
async function waitFor(page, selector, timeout = 60000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  return page.$(selector);
}

/** Find and click an element by its text content. */
async function clickByText(page, selector, text) {
  const elements = await page.$$(selector);
  for (const el of elements) {
    const elText = await page.evaluate((e) => e.textContent, el);
    if (elText && elText.includes(text)) {
      await el.click();
      return true;
    }
  }
  return false;
}

module.exports = async (browser, context) => {
  const webUrl = process.env.WEB_URL;
  const platformUrl = process.env.PLATFORM_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!webUrl) throw new Error("WEB_URL environment variable is required");
  if (!platformUrl)
    throw new Error("PLATFORM_URL environment variable is required");

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  // Set Vercel bypass cookie if needed
  if (bypassSecret) {
    await page.goto(
      `${webUrl}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`,
      { waitUntil: "networkidle0", timeout: 60000 },
    );

    // Also set bypass cookie on the platform domain
    await page.goto(
      `${platformUrl}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`,
      { waitUntil: "networkidle0", timeout: 60000 },
    );
  }

  // Navigate directly to sign-in page. Don't wait for network idle —
  // Clerk/Termly analytics keep the network busy for 20s+ and will eat
  // into the timeout budget. Instead, wait directly for the Clerk form.
  await page.goto(`${webUrl}/sign-in`, { waitUntil: "domcontentloaded" });

  // Wait for Clerk identifier input to be visible
  const emailInput = await waitFor(page, 'input[name="identifier"]');

  // Dismiss cookie consent banner if present (it can block button clicks)
  await clickByText(page, "button", "Accept");
  await emailInput.type(TEST_EMAIL);
  const continueBtn = await waitFor(page, ".cl-formButtonPrimary");
  await continueBtn.click();

  // Wait for factor-one page with "Use another method" link
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("a, button")].some((el) =>
        el.textContent?.includes("Use another method"),
      ),
    { timeout: 15000 },
  );

  // Switch to email code method
  await clickByText(page, "a, button", "Use another method");

  // Wait for method selection and choose email code
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Email code"),
      ),
    { timeout: 10000 },
  );
  await clickByText(page, "button", "Email code");

  // Wait for OTP input and enter code
  await page.waitForSelector('input[data-input-otp="true"]', {
    visible: true,
    timeout: 15000,
  });

  // Enter OTP with retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const otpInput = await page.$('input[data-input-otp="true"]');
    if (otpInput) {
      await otpInput.click();
      await otpInput.type(TEST_OTP);

      // Wait for navigation away from sign-in (allow extra time for auth processing)
      try {
        await page.waitForFunction(
          () => !window.location.href.includes("/sign-in"),
          { timeout: 15000 },
        );
        break;
      } catch {
        // Still on sign-in page, clear and retry
        await otpInput.click({ clickCount: 3 });
        await page.keyboard.press("Backspace");
        await page.waitForFunction(
          () => {
            const input = document.querySelector(
              'input[data-input-otp="true"]',
            );
            return input && input.value === "";
          },
          { timeout: 5000 },
        );
      }
    }
  }

  // Verify authentication succeeded
  const finalUrl = page.url();
  if (finalUrl.includes("/sign-in")) {
    throw new Error(
      `Authentication failed after 3 OTP attempts. Still on ${finalUrl}`,
    );
  }

  // Navigate to platform to ensure session is established there too
  await page.goto(platformUrl, { waitUntil: "networkidle0", timeout: 60000 });

  // Close this setup page — LHCI will open its own pages for auditing
  await page.close();
};
