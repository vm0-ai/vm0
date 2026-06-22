import {
  clerk,
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

const ONBOARDING_STATUS_PATH = "**/api/zero/onboarding/status";
const READY_ONBOARDING_STATUS = JSON.stringify({
  needsOnboarding: false,
  isAdmin: true,
  hasOrg: true,
  hasDefaultAgent: false,
  defaultAgentId: null,
  defaultAgentMetadata: null,
});

test("sign in through onboarding handoff to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

  await clerkSetup();
  await setupClerkTestingToken({ page });

  // Navigate to app — redirects to www sign-in
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname.includes("/sign-in"), {
    timeout: 30_000,
  });
  const authUrl = page.url();
  const redirectUrl = redirectUrlFromAuthUrl(new URL(authUrl));

  // Sign in
  await signInWithClerkTestingHelper(page, email, appUrl, authUrl, redirectUrl);

  // Navigate to app — should land on the onboarding handoff or agents
  await page.goto(appUrl);
  await page.waitForURL(
    (url) => {
      const p = url.pathname;
      return p.includes("/onboarding") || p.includes("/agents/");
    },
    { timeout: 30_000 },
  );

  // Follow the external onboarding auth handoff if needed
  if (page.url().includes("/onboarding")) {
    await completeOnboardingThroughApi(page, appUrl);
  }

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });
});

async function completeOnboardingThroughApi(
  page: Page,
  appUrl: string,
): Promise<void> {
  const apiUrl = deriveApiUrl(appUrl);
  const headers = await authHeadersForApp(page, appUrl);
  const setupResponse = await page.request.post(
    `${apiUrl}/api/zero/onboarding/setup`,
    {
      headers,
      data: {
        displayName: "E2E Test Agent",
        workspaceName: "E2E Test Workspace",
        selectedConnectors: [],
        timezone: "UTC",
      },
    },
  );
  await expectStatus(setupResponse, [200, 409], "onboarding setup");

  const checkoutUrl = await createOnboardingTrialCheckout(
    page,
    appUrl,
    apiUrl,
    headers,
  );
  await page.goto(checkoutUrl, { waitUntil: "domcontentloaded" });
  await fillStripeCheckout(page);
}

async function createOnboardingTrialCheckout(
  page: Page,
  appUrl: string,
  apiUrl: string,
  headers: Readonly<Record<"Authorization", string>>,
): Promise<string> {
  const successUrl = new URL("/", appUrl);
  successUrl.searchParams.set("billing", "pro");
  successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
  const stripeSuccessUrl = successUrl
    .toString()
    .replace(
      "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
      "billing_session_id={CHECKOUT_SESSION_ID}",
    );

  const cancelUrl = new URL("/", appUrl);
  cancelUrl.searchParams.set("billing", "canceled");

  const checkoutResponse = await page.request.post(
    `${apiUrl}/api/zero/billing/checkout`,
    {
      headers,
      data: {
        tier: "pro",
        trialDays: 7,
        successUrl: stripeSuccessUrl,
        cancelUrl: cancelUrl.toString(),
      },
    },
  );
  await expectStatus(checkoutResponse, [200], "onboarding trial checkout");

  const body: unknown = await checkoutResponse.json();
  if (!hasCheckoutUrl(body)) {
    throw new Error(`Unexpected checkout response: ${JSON.stringify(body)}`);
  }
  return body.url;
}

async function authHeadersForApp(
  page: Page,
  appUrl: string,
): Promise<Readonly<Record<"Authorization", string>>> {
  const token = await clerkSessionTokenForApp(page, appUrl);
  return { Authorization: `Bearer ${token}` };
}

async function clerkSessionTokenForApp(
  page: Page,
  appUrl: string,
): Promise<string> {
  await page.route(ONBOARDING_STATUS_PATH, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: READY_ONBOARDING_STATUS,
    });
  });

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(window.Clerk?.session),
      undefined,
      { timeout: 30_000 },
    );

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const token = await page.evaluate(async () => {
        const session = window.Clerk?.session;
        return session ? await session.getToken() : null;
      });
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
      await page.waitForTimeout(250);
    }
  } finally {
    await page.unroute(ONBOARDING_STATUS_PATH);
  }

  throw new Error(`Unable to read Clerk session token from ${page.url()}`);
}

async function expectStatus(
  response: APIResponse,
  statuses: readonly number[],
  action: string,
): Promise<void> {
  if (statuses.includes(response.status())) {
    return;
  }

  throw new Error(
    `${action} failed with ${response.status()}: ${await response.text()}`,
  );
}

function hasCheckoutUrl(value: unknown): value is { readonly url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function deriveApiUrl(appUrl: string): string {
  return appUrl.replace(/-app\./, "-api.").replace(/\/\/app\./, "//api.");
}

async function signInWithClerkTestingHelper(
  page: Page,
  email: string,
  appUrl: string,
  authUrl: string,
  redirectUrl: string | null,
): Promise<void> {
  const helperUrl = new URL("/_/skeleton", appUrl);
  await page.goto(helperUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded), undefined, {
    timeout: 30_000,
  });
  const clerkStateBefore = await page.evaluate(() => {
    return {
      hasLoadedClerk: Boolean(window.Clerk?.loaded),
      hasSession: Boolean(window.Clerk?.session),
      hasUser: Boolean(window.Clerk?.user),
    };
  });

  console.log("[smoke] signing in with Clerk testing helper", {
    currentUrl: page.url(),
    authUrl,
    email,
    redirectUrl,
    ...clerkStateBefore,
  });

  await clerk.signIn({ page, emailAddress: email });
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });

  const clerkState = await page.evaluate(() => {
    return {
      hasSession: Boolean(window.Clerk?.session),
      hasUser: Boolean(window.Clerk?.user),
    };
  });
  console.log("[smoke] Clerk testing helper completed", {
    currentUrl: page.url(),
    ...clerkState,
  });

  if (redirectUrl) {
    await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
  }
}

function redirectUrlFromAuthUrl(url: URL): string | null {
  const searchRedirect = url.searchParams.get("redirect_url");
  if (searchRedirect) {
    return searchRedirect;
  }

  const hashQueryStart = url.hash.indexOf("?");
  if (hashQueryStart === -1) {
    return null;
  }

  return new URLSearchParams(url.hash.slice(hashQueryStart + 1)).get(
    "redirect_url",
  );
}
