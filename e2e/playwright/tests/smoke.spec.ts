import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

const TEST_OTP = "424242";
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

  // Sign in
  await signInWithEmailCode(
    page,
    email,
    redirectUrlFromAuthUrl(new URL(page.url())),
    60_000,
  );

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

async function signInWithEmailCode(
  page: Page,
  email: string,
  redirectUrl: string | null,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;

  await waitForVisible(
    page.locator('input[name="identifier"]').first(),
    remainingTimeout(deadline, 20_000),
  );
  await clickIfVisible(page.getByRole("button", { name: "Accept" }), 2_000);

  await page.locator('input[name="identifier"]').first().fill(email);
  await page.getByRole("button", { name: "Continue" }).click();

  const flow = await waitForEmailCodeFlow(
    page,
    remainingTimeout(deadline, 15_000),
  );
  if (flow === "alt") {
    await page
      .locator("a, button")
      .filter({ hasText: "Use another method" })
      .first()
      .click();
    await page
      .locator("button")
      .filter({ hasText: "Email code" })
      .first()
      .click();
  }

  if (flow !== "redirected") {
    await submitEmailCode(page, remainingTimeout(deadline, 30_000));
  }

  if (redirectUrl && !isOnboardingOrChatUrl(new URL(page.url()))) {
    await page.goto(redirectUrl, { waitUntil: "domcontentloaded" });
  }
}

async function clickIfVisible(
  locator: Locator,
  timeout: number,
): Promise<void> {
  if (await waitForVisible(locator, timeout)) {
    await locator.click();
  }
}

async function waitForEmailCodeFlow(
  page: Page,
  timeout: number,
): Promise<"otp" | "alt" | "redirected"> {
  const result = await page.waitForFunction(
    () => {
      const { pathname } = window.location;
      if (!pathname.includes("/sign-up") && !pathname.includes("/sign-in")) {
        return "redirected";
      }

      const hasOtp = Boolean(
        document.querySelector('input[data-input-otp="true"]'),
      );
      const hasAltMethod = Array.from(
        document.querySelectorAll("a, button"),
      ).some((element) => {
        return element.textContent?.includes("Use another method") ?? false;
      });

      if (hasOtp) {
        return "otp";
      }
      if (hasAltMethod) {
        return "alt";
      }
      return false;
    },
    undefined,
    { timeout },
  );
  const flow = await result.jsonValue();
  if (flow === "otp" || flow === "alt" || flow === "redirected") {
    return flow;
  }
  throw new Error(`Unexpected Clerk sign-in flow: ${String(flow)}`);
}

async function submitEmailCode(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  const otpInput = page.locator('input[data-input-otp="true"]').first();
  await waitForVisible(otpInput, remainingTimeout(deadline, 15_000));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const navigation = waitForNonAuthUrl(
      page,
      remainingTimeout(deadline, 15_000),
    );
    await otpInput.click();
    await otpInput.type(TEST_OTP);

    if (await navigation) {
      return;
    }

    if (!isAuthUrl(new URL(page.url()))) {
      return;
    }

    await otpInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
  }

  throw new Error(`Authentication failed after OTP attempts: ${page.url()}`);
}

async function waitForVisible(
  locator: Locator,
  timeout: number,
): Promise<boolean> {
  return await locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForNonAuthUrl(
  page: Page,
  timeout: number,
): Promise<boolean> {
  return await page
    .waitForURL((url) => !isAuthUrl(url), {
      timeout,
      waitUntil: "domcontentloaded",
    })
    .then(() => true)
    .catch(() => false);
}

function remainingTimeout(deadline: number, maxTimeout: number): number {
  return Math.max(1, Math.min(maxTimeout, deadline - Date.now()));
}

function isAuthUrl(url: URL): boolean {
  return url.pathname.includes("/sign-up") || url.pathname.includes("/sign-in");
}

function isChatUrl(url: URL): boolean {
  return /\/agents\/.*\/chat/.test(url.pathname);
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

function isOnboardingOrChatUrl(url: URL): boolean {
  return url.pathname.includes("/onboarding") || isChatUrl(url);
}
