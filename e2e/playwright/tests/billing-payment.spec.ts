import { expect, test, type Locator, type Page } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

interface ApiFetchResult {
  readonly status: number;
  readonly body: unknown;
}

interface ClerkWindow {
  readonly Clerk?: {
    readonly session?: {
      getToken: () => Promise<string | null>;
    };
  };
}

function deriveWebUrlFromApp(currentUrl: string): string {
  const url = new URL(currentUrl);
  url.hostname = url.hostname.replace(/(^|-)(app|platform|api)\./, "$1www.");
  return url.origin;
}

async function clerkToken(page: Page): Promise<string | null> {
  return await page
    .evaluate(async () => {
      return (window as ClerkWindow).Clerk?.session?.getToken() ?? null;
    })
    .catch(() => {
      return null;
    });
}

async function authedApiFetch(
  page: Page,
  path: string,
  init?: {
    readonly method?: string;
    readonly body?: Record<string, unknown>;
  },
): Promise<ApiFetchResult> {
  const token = await clerkToken(page);
  const response = await page
    .context()
    .request.fetch(`${deriveWebUrlFromApp(page.url())}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: init?.body,
    });
  const text = await response.text();
  return {
    status: response.status(),
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

async function pollBillingTier(
  page: Page,
  tier: "free" | "pro" | "team",
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await authedApiFetch(page, "/api/zero/billing/status");
        if (
          response.status !== 200 ||
          typeof response.body !== "object" ||
          response.body === null ||
          !("tier" in response.body)
        ) {
          return null;
        }
        return response.body.tier;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(tier);
}

async function fillFirst(locator: Locator, value: string): Promise<boolean> {
  try {
    await locator.first().fill(value, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function fillStripeField(
  page: Page,
  locator: Locator,
  fallbackPlaceholder: RegExp,
  value: string,
): Promise<void> {
  if (await fillFirst(locator, value)) {
    return;
  }
  await page
    .frameLocator("iframe")
    .getByPlaceholder(fallbackPlaceholder)
    .first()
    .fill(value, { timeout: 10_000 });
}

async function fillStripeCheckout(page: Page): Promise<void> {
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  await fillFirst(
    page.getByLabel(/email/i).or(page.locator('input[name="email"]')),
    `billing-e2e-${Date.now()}@vm0-e2e.ai`,
  );

  await fillStripeField(
    page,
    page
      .getByLabel(/card number/i)
      .or(page.getByPlaceholder(/1234 1234 1234 1234/i))
      .or(page.locator('input[name="cardNumber"]')),
    /1234 1234 1234 1234/i,
    "4242424242424242",
  );
  await fillStripeField(
    page,
    page
      .getByLabel(/expiration|expiry/i)
      .or(page.getByPlaceholder(/MM\s*\/\s*YY/i))
      .or(page.locator('input[name="cardExpiry"]')),
    /MM\s*\/\s*YY/i,
    "1234",
  );
  await fillStripeField(
    page,
    page
      .getByLabel(/security code|cvc/i)
      .or(page.getByPlaceholder(/CVC/i))
      .or(page.locator('input[name="cardCvc"]')),
    /CVC/i,
    "123",
  );
  await fillFirst(
    page
      .getByLabel(/cardholder name|name on card/i)
      .or(page.locator('input[name="billingName"]')),
    "VM0 Billing E2E",
  );
  await fillFirst(
    page
      .getByLabel(/zip|postal/i)
      .or(page.locator('input[name="billingPostalCode"]')),
    "94107",
  );

  await page
    .getByRole("button", { name: /subscribe|pay|start trial/i })
    .click({ timeout: 30_000 });
}

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Free plan")).toBeVisible({ timeout: 30_000 });
}

test("paid checkout redirects to Stripe and completes successfully", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await openBillingSettings(page);

  await page.getByRole("button", { name: "Compare all plans" }).click();
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();

  await fillStripeCheckout(page);

  await page.waitForURL(
    (url) => {
      return (
        url.origin === new URL(appUrl).origin &&
        url.searchParams.get("billing") === "pro" &&
        Boolean(url.searchParams.get("billing_session_id"))
      );
    },
    { timeout: 90_000, waitUntil: "domcontentloaded" },
  );

  await expect(page.getByText(/Upgraded to Pro/i)).toBeVisible({
    timeout: 30_000,
  });
  await pollBillingTier(page, "pro");

  const cleanup = await authedApiFetch(page, "/api/zero/billing/downgrade", {
    method: "POST",
    body: { targetTier: "free" },
  });
  expect([200, 409]).toContain(cleanup.status);
});
