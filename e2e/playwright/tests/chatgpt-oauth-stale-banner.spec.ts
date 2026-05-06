import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

/**
 * Test 4 (UI portion) for issue #11941: stale-provider banner + re-connect
 * CTA in OrgProvidersTab when a chatgpt-oauth-token provider has
 * needsReconnect=true.
 *
 * REQUIRES Wave 3 (#11932). The probe at the top of the test skips when
 * Wave 3's API surface (modelProviderResponseSchema with needsReconnect
 * field) hasn't shipped — keeps this PR mergeable before #11932 lands.
 *
 * Test contract for the Wave 3 implementer of #11932:
 *   - Banner DOM element: data-testid="chatgpt-stale-banner"
 *   - Re-connect link inside the banner: accessible name matching /re-?connect chatgpt/i
 *   - Link href: must contain "/api/zero/chatgpt/oauth/connect"
 * Coordinate via PR-comment cross-link before merging #11932.
 */
test("chatgpt-oauth stale provider renders banner with re-connect CTA", async ({
  page,
  request,
}) => {
  const apiUrl = process.env.VM0_API_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!apiUrl || !email) {
    test.skip(true, "VM0_API_URL or E2E_CLERK_USER_EMAIL not set");
    return;
  }

  // Probe: Wave 3 (#11932) widens modelProviderResponseSchema with the
  // needsReconnect field. If absent, skip — this test will auto-activate
  // once #11932 ships.
  const probeHeaders: Record<string, string> = {};
  if (bypassSecret) {
    probeHeaders["x-vercel-protection-bypass"] = bypassSecret;
  }
  const probe = await request.get(`${apiUrl}/api/zero/model-providers`, {
    headers: probeHeaders,
  });
  if (!probe.ok()) {
    test.skip(true, `model-providers probe failed: ${probe.status()}`);
    return;
  }
  const providers = await probe.json();
  if (
    !Array.isArray(providers) ||
    providers.length === 0 ||
    !("needsReconnect" in providers[0])
  ) {
    test.skip(
      true,
      "Wave 3 (#11932) features not yet shipped — needsReconnect field absent from API response",
    );
    return;
  }

  // Seed a stale chatgpt-oauth-token provider via the test endpoint.
  const seedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bypassSecret) {
    seedHeaders["x-vercel-protection-bypass"] = bypassSecret;
  }
  const encodedEmail = email.replace(/\+/g, "%2B").replace(/@/g, "%40");
  const seedResp = await request.post(
    `${apiUrl}/api/cli/auth/test-chatgpt-oauth?email=${encodedEmail}`,
    {
      headers: seedHeaders,
      data: {
        accessToken: "stale-at-pw",
        refreshToken: "stale-rt-pw",
        accountId: "ws_stale_pw",
        idToken: "id-tok-pw",
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      },
    },
  );
  expect(seedResp.ok()).toBeTruthy();

  // Sign in via Clerk and navigate to the providers settings page.
  await clerkSetup();
  const appUrl = deriveAppUrl(apiUrl);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await clerk.signIn({ page, emailAddress: email });

  await page.goto(`${appUrl}/settings/model-providers`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Banner is visible.
  const banner = page.locator("[data-testid='chatgpt-stale-banner']");
  await expect(banner).toBeVisible({ timeout: 30_000 });

  // Re-connect CTA inside the banner points at the OAuth connect route.
  const cta = banner.getByRole("link", { name: /re-?connect chatgpt/i });
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  expect(href).toContain("/api/zero/chatgpt/oauth/connect");
});
