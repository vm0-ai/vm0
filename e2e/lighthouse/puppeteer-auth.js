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
async function waitFor(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  return page.$(selector);
}

/** Sleep for the given number of milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async (browser, context) => {
  const webUrl = process.env.WEB_URL;
  const platformUrl = process.env.PLATFORM_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!webUrl) throw new Error("WEB_URL environment variable is required");
  if (!platformUrl)
    throw new Error("PLATFORM_URL environment variable is required");

  const page = await browser.newPage();

  // Set Vercel bypass cookie if needed
  if (bypassSecret) {
    await page.goto(
      `${webUrl}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`,
    );
    await page.waitForNetworkIdle({ idleTime: 1000 });

    // Also set bypass cookie on the platform domain
    await page.goto(
      `${platformUrl}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`,
    );
    await page.waitForNetworkIdle({ idleTime: 1000 });
  }

  // Navigate to web app landing page
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await page.waitForNetworkIdle({ idleTime: 1000 });

  // Click sign-up link in navbar to start auth flow
  const signUpLink = await waitFor(page, "a.btn-get-access[href='/sign-up']");
  await signUpLink.click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded" });

  // Switch to sign-in (test account already exists)
  const signInLink = await waitFor(page, 'a[href*="sign-in"]');
  await signInLink.click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded" });

  // Enter email
  const emailInput = await waitFor(page, 'input[name="identifier"]');
  await emailInput.type(TEST_EMAIL);

  // Click continue
  const continueBtn = await waitFor(page, ".cl-formButtonPrimary");
  await continueBtn.click();
  await sleep(2000);

  // Switch to email code method
  const useAnotherMethod = await waitFor(page, 'a[class*="link"]:not([href])');
  // Find the "Use another method" link by text content
  const links = await page.$$("a, button");
  for (const link of links) {
    const text = await page.evaluate((el) => el.textContent, link);
    if (text && text.includes("Use another method")) {
      await link.click();
      break;
    }
  }
  await sleep(1000);

  // Select email code option
  const buttons = await page.$$("button");
  for (const button of buttons) {
    const text = await page.evaluate((el) => el.textContent, button);
    if (text && text.includes("Email code")) {
      await button.click();
      break;
    }
  }
  await sleep(2000);

  // Enter OTP with retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const otpInput = await page.$('input[data-input-otp="true"]');
    if (otpInput) {
      await otpInput.click();
      await otpInput.type(TEST_OTP);
      await sleep(3000);

      // Check if we navigated away from sign-in
      const currentUrl = page.url();
      if (!currentUrl.includes("/sign-in")) {
        break;
      }

      // Clear and retry
      await otpInput.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await sleep(2000);
    } else {
      await sleep(2000);
    }
  }

  // Wait for authentication to complete — either redirected to platform
  // or still on web with authenticated state
  await sleep(3000);

  // Navigate to platform to ensure session is established there too
  await page.goto(platformUrl, { waitUntil: "domcontentloaded" });
  await page.waitForNetworkIdle({ idleTime: 2000 });

  // Close this setup page — LHCI will open its own pages for auditing
  await page.close();
};
