import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

/**
 * Paste-modal happy path + error paths for the codex-oauth-token provider.
 *
 * Wave 2 contract (post-#11978 + #11980):
 *   - Paste modal data-testid="codex-paste-modal"
 *   - Textarea data-testid="codex-paste-modal-textarea"
 *   - Submit button data-testid="codex-paste-modal-submit"
 *   - Inline error data-testid="codex-paste-modal-error" with text
 *     content matching the parser's typed-error message (shape error /
 *     free-plan rejection — assertions tolerant to wording shifts)
 *
 * Skips via runtime probe when paste flow is not yet wired (server-side
 * parser absent OR modal testid absent in DOM).
 */

const VALID_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    access_token:
      "REAL-AT-pw-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718-DO-NOT-LEAK",
    refresh_token:
      "REAL-RT-pw-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6-DO-NOT-LEAK",
    account_id: "ws_REAL_ACCOUNT_pw_DO_NOT_LEAK",
    id_token: "hdr-REAL-IDTOK-pw.body-payload.sig",
  },
  last_refresh: "2026-05-06T00:00:00Z",
});

async function pasteFlowSupported(
  request: import("@playwright/test").APIRequestContext,
  apiUrl: string,
  email: string,
  bypassSecret: string | undefined,
): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  const encodedEmail = email.replace(/\+/g, "%2B").replace(/@/g, "%40");
  const resp = await request.post(
    `${apiUrl}/api/cli/auth/test-codex-oauth?email=${encodedEmail}`,
    {
      headers,
      data: { authJson: "{ not json" },
    },
  );
  // #11978's parser returns 400 for any malformed authJson. If the test
  // endpoint hasn't accepted the authJson variant (which would manifest
  // as a 400 from zod with "Invalid body shape"), the body has an
  // `issues` array; the parser path returns `error` only.
  if (resp.status() !== 400) {
    return false;
  }
  const body = await resp.json();
  return typeof body.error === "string" && !("issues" in body);
}

async function ensurePasteModalAvailable(
  page: import("@playwright/test").Page,
  appUrl: string,
  email: string,
): Promise<boolean> {
  await clerkSetup();
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await clerk.signIn({ page, emailAddress: email });
  await page.goto(`${appUrl}/settings/model-providers`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const addButton = page.getByRole("button", { name: /add provider/i });
  if ((await addButton.count()) === 0) {
    return false;
  }
  await addButton.click();

  const codexCard = page.locator("[data-testid='provider-card-codex-oauth-token']");
  if ((await codexCard.count()) === 0) {
    return false;
  }
  await codexCard.click();

  const modal = page.locator("[data-testid='codex-paste-modal']");
  return (await modal.count()) > 0;
}

test.describe("codex-oauth paste flow", () => {
  test("happy path: paste valid auth.json → modal closes, provider in list", async ({
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
    if (!(await pasteFlowSupported(request, apiUrl, email, bypassSecret))) {
      test.skip(true, "Paste flow not yet wired (sub-issue #11978 pending)");
      return;
    }

    const appUrl = deriveAppUrl(apiUrl);
    if (!(await ensurePasteModalAvailable(page, appUrl, email))) {
      test.skip(
        true,
        "Paste modal not yet shipped (sub-issue #11980 pending)",
      );
      return;
    }

    const modal = page.locator("[data-testid='codex-paste-modal']");
    const textarea = modal.locator("[data-testid='codex-paste-modal-textarea']");
    const submit = modal.locator("[data-testid='codex-paste-modal-submit']");

    // Submit disabled with empty textarea
    await expect(submit).toBeDisabled();

    // Paste valid auth.json
    await textarea.fill(VALID_AUTH_JSON);
    await expect(submit).toBeEnabled();

    await submit.click();

    // Modal closes
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // Provider row appears in the list
    const providerRow = page.locator(
      "[data-testid='provider-row-codex-oauth-token']",
    );
    await expect(providerRow).toBeVisible({ timeout: 10_000 });
  });

  test("rejects malformed JSON inline", async ({ page, request }) => {
    const apiUrl = process.env.VM0_API_URL;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const email = process.env.E2E_CLERK_USER_EMAIL;
    if (!apiUrl || !email) {
      test.skip(true, "VM0_API_URL or E2E_CLERK_USER_EMAIL not set");
      return;
    }
    if (!(await pasteFlowSupported(request, apiUrl, email, bypassSecret))) {
      test.skip(true, "Paste flow not yet wired (sub-issue #11978 pending)");
      return;
    }

    const appUrl = deriveAppUrl(apiUrl);
    if (!(await ensurePasteModalAvailable(page, appUrl, email))) {
      test.skip(
        true,
        "Paste modal not yet shipped (sub-issue #11980 pending)",
      );
      return;
    }

    const modal = page.locator("[data-testid='codex-paste-modal']");
    const textarea = modal.locator("[data-testid='codex-paste-modal-textarea']");
    const submit = modal.locator("[data-testid='codex-paste-modal-submit']");

    await textarea.fill("not valid json {");
    await submit.click();

    const error = modal.locator("[data-testid='codex-paste-modal-error']");
    await expect(error).toBeVisible({ timeout: 10_000 });
    await expect(error).toContainText(/shape invalid|invalid/i);
    await expect(modal).toBeVisible();
  });

  test("rejects free plan inline", async ({ page, request }) => {
    const apiUrl = process.env.VM0_API_URL;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const email = process.env.E2E_CLERK_USER_EMAIL;
    if (!apiUrl || !email) {
      test.skip(true, "VM0_API_URL or E2E_CLERK_USER_EMAIL not set");
      return;
    }
    if (!(await pasteFlowSupported(request, apiUrl, email, bypassSecret))) {
      test.skip(true, "Paste flow not yet wired (sub-issue #11978 pending)");
      return;
    }

    const appUrl = deriveAppUrl(apiUrl);
    if (!(await ensurePasteModalAvailable(page, appUrl, email))) {
      test.skip(
        true,
        "Paste modal not yet shipped (sub-issue #11980 pending)",
      );
      return;
    }

    // Build an id_token with chatgpt_plan_type="free". Uses btoa (browser-
    // and node-native) instead of Buffer to avoid pulling Node types into
    // the Playwright spec (which runs in a node context but has no
    // @types/node at the e2e workspace level).
    const claims = {
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "free",
        chatgpt_account_id: "test-acc",
      },
    };
    const payloadB64 = btoa(JSON.stringify(claims))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const freePlanIdToken = `hdr.${payloadB64}.sig`;

    const freePlanAuthJson = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "at",
        refresh_token: "rt",
        account_id: "ai",
        id_token: freePlanIdToken,
      },
      last_refresh: "2026-05-06T00:00:00Z",
    });

    const modal = page.locator("[data-testid='codex-paste-modal']");
    const textarea = modal.locator("[data-testid='codex-paste-modal-textarea']");
    const submit = modal.locator("[data-testid='codex-paste-modal-submit']");

    await textarea.fill(freePlanAuthJson);
    await submit.click();

    const error = modal.locator("[data-testid='codex-paste-modal-error']");
    await expect(error).toBeVisible({ timeout: 10_000 });
    await expect(error).toContainText(/free plan/i);
    await expect(modal).toBeVisible();
  });
});
