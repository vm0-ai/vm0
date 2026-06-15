import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

/**
 * Stale-provider banner + re-paste CTA in OrgProvidersTab when a
 * codex-oauth-token provider has needsReconnect=true.
 *
 * Wave 2 paste-flow target state (post-#11978 + #11980):
 *   - Banner DOM element: data-testid="codex-stale-banner"
 *   - Re-paste CTA inside the banner: accessible name matching
 *     /re-?paste auth\.json/i
 *   - Click CTA opens the paste modal in-page (no cross-origin redirect)
 *   - Paste modal data-testid="codex-paste-modal"
 *
 * Wave 3 dependency (#11932): needsReconnect field on
 * modelProviderResponseSchema. Without it the seed has no observable
 * effect on the UI.
 *
 * Both gates use runtime probes — the test auto-activates once both
 * #11932 and #11978/#11980 ship without further code changes here.
 */
test("codex-oauth stale provider renders banner with re-paste CTA", async ({
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
  // needsReconnect field. If absent, skip — this test auto-activates
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

  // Seed a stale codex-oauth-token provider via the test endpoint.
  // Uses the legacy raw_secrets shape — paste-flow seed isn't needed here
  // because we're driving the BANNER, not the SEED endpoint behavior.
  const seedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bypassSecret) {
    seedHeaders["x-vercel-protection-bypass"] = bypassSecret;
  }
  const encodedEmail = email.replace(/\+/g, "%2B").replace(/@/g, "%40");
  const seedResp = await request.post(
    `${apiUrl}/api/cli/auth/test-codex-oauth?email=${encodedEmail}`,
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

  // Probe: paste-flow target testid. If the banner uses the legacy
  // chatgpt-stale-banner testid (i.e. #11980 hasn't shipped yet), skip —
  // the stale-banner contract under paste flow uses the codex-* testid.
  const codexBanner = page.locator("[data-testid='codex-stale-banner']");
  if ((await codexBanner.count()) === 0) {
    test.skip(
      true,
      "Paste-flow stale banner (codex-stale-banner) not yet shipped — sub-issue #11980 pending",
    );
    return;
  }

  await expect(codexBanner).toBeVisible({ timeout: 30_000 });

  // Re-paste CTA opens the paste modal in-page (no cross-origin redirect).
  const cta = codexBanner.getByRole("button", { name: /re-?paste auth\.json/i });
  await expect(cta).toBeVisible();
  await cta.click();

  const modal = page.locator("[data-testid='codex-paste-modal']");
  await expect(modal).toBeVisible({ timeout: 10_000 });
});
