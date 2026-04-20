/**
 * Minimal Puppeteer script for Lighthouse CI web audits.
 *
 * Sets the Vercel automation bypass cookie so Lighthouse can access
 * preview deployments. No authentication is needed for the public web homepage.
 *
 * Contract: module.exports = async (browser, context) => { ... }
 * Do NOT close the browser — LHCI manages the lifecycle.
 *
 * Environment variables:
 *   VERCEL_AUTOMATION_BYPASS_SECRET – Vercel protection bypass token
 */

module.exports = async (browser, context) => {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (bypassSecret) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.goto(
      `${context.url}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`,
      { waitUntil: "networkidle0", timeout: 60000 },
    );
    await page.close();
  }
};
