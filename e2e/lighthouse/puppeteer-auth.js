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

  // Navigate to web app landing page
  await page.goto(webUrl, { waitUntil: "networkidle0", timeout: 60000 });

  // Click sign-up link in navbar to start auth flow
  const signUpLink = await waitFor(page, "a.btn-get-access[href='/sign-up']");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    signUpLink.click(),
  ]);
  // Wait for the sign-up page to render (Clerk UI)
  await page.waitForFunction(
    () => window.location.href.includes("/sign-up"),
    { timeout: 30000 },
  );

  // Switch to sign-in (test account already exists)
  const signInLink = await waitFor(page, 'a[href*="sign-in"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    signInLink.click(),
  ]);
  // Wait for the sign-in page to render
  await page.waitForFunction(
    () => window.location.href.includes("/sign-in"),
    { timeout: 30000 },
  );

  // Enter email
  const emailInput = await waitFor(page, 'input[name="identifier"]');
  await emailInput.type(TEST_EMAIL);

  // Click continue and wait for the next form to load
  const continueBtn = await waitFor(page, ".cl-formButtonPrimary");
  await continueBtn.click();
  await page.waitForSelector('a[class*="link"]:not([href])', {
    visible: true,
    timeout: 15000,
  });

  // Switch to email code method
  const links = await page.$$("a, button");
  for (const link of links) {
    const text = await page.evaluate((el) => el.textContent, link);
    if (text && text.includes("Use another method")) {
      await link.click();
      break;
    }
  }

  // Wait for method selection buttons to appear
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Email code"),
      ),
    { timeout: 10000 },
  );

  // Select email code option
  const buttons = await page.$$("button");
  for (const button of buttons) {
    const text = await page.evaluate((el) => el.textContent, button);
    if (text && text.includes("Email code")) {
      await button.click();
      break;
    }
  }

  // Wait for OTP input to appear
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

      // Wait for navigation away from sign-in
      try {
        await page.waitForFunction(
          () => !window.location.href.includes("/sign-in"),
          { timeout: 5000 },
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
