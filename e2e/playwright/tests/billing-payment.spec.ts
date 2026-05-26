import { expect, test, type Locator, type Page } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

async function fillFirst(
  locator: Locator,
  value: string,
  timeout = 5_000,
): Promise<boolean> {
  try {
    await locator.first().fill(value, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function fillStripeFrameField(
  page: Page,
  fallbackPlaceholder: RegExp,
  value: string,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (
        await fillFirst(frame.getByPlaceholder(fallbackPlaceholder), value, 500)
      ) {
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  return false;
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
  if (await fillStripeFrameField(page, fallbackPlaceholder, value)) {
    return;
  }

  throw new Error(
    `Unable to fill Stripe field with placeholder ${fallbackPlaceholder}`,
  );
}

async function disableLinkSaveInfo(page: Page): Promise<void> {
  const saveInfo = page.getByRole("checkbox", {
    name: /save my information/i,
  });

  if (await saveInfo.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await saveInfo.uncheck();
  }
}

async function fillStripeCheckout(page: Page): Promise<void> {
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  await fillFirst(
    page.getByLabel(/email/i).or(page.locator('input[name="email"]')),
    `billing-e2e-${Date.now()}@vm0-e2e.ai`,
  );
  await disableLinkSaveInfo(page);
  await page
    .getByRole("button", { name: /pay with card/i })
    .dispatchEvent("click", undefined, { timeout: 10_000 });

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
    .getByRole("button", { name: /^subscribe$/i })
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
        /^cs_/.test(url.searchParams.get("billing_session_id") ?? "")
      );
    },
    { timeout: 90_000, waitUntil: "domcontentloaded" },
  );
});
