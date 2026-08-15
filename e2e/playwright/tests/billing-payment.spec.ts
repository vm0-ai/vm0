import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { authHeadersForToken } from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

const apiUrl = process.env.VM0_API_BACKEND_URL!;
const appUrl = deriveAppUrl(apiUrl);

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

async function openCreditBalanceSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=usage`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

test("billing settings reflects limited free onboarding", async ({ page }) => {
  await openBillingSettings(page);

  await expectLimitedFreeBillingStatus(page);
  await expect(page.getByText(/^No active plan$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No active subscription")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade" })).toBeVisible();
  await expect(page.getByText(/^Pro plan$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Downgrade" })).toHaveCount(0);
});

test("credit balance bars render with matching outer corner radii", async ({
  page,
}) => {
  await enableUsagePackPlans(page);
  await mockCreditBalance(page);
  await openCreditBalanceSettings(page);

  const allowanceBar = page.getByRole("progressbar").first();
  const firstOrgCreditBar = page.getByTestId("credit-balance-segment-plan:pro");
  const lastOrgCreditBar = page.getByTestId(
    "credit-balance-segment-payAsYouGo",
  );
  await expect(allowanceBar).toBeVisible({ timeout: 30_000 });
  await expect(firstOrgCreditBar).toBeVisible();
  await expect(lastOrgCreditBar).toBeVisible();

  const allowanceRadii = await renderedCornerRadii(allowanceBar);
  const firstOrgCreditRadii = await renderedCornerRadii(firstOrgCreditBar);
  const lastOrgCreditRadii = await renderedCornerRadii(lastOrgCreditBar);

  expect(firstOrgCreditRadii.topLeft).toBe(allowanceRadii.topLeft);
  expect(firstOrgCreditRadii.bottomLeft).toBe(allowanceRadii.bottomLeft);
  expect(lastOrgCreditRadii.topRight).toBe(allowanceRadii.topRight);
  expect(lastOrgCreditRadii.bottomRight).toBe(allowanceRadii.bottomRight);
  expect(allowanceRadii.topLeft).not.toBe("0px");
  expect([
    firstOrgCreditRadii.topRight,
    firstOrgCreditRadii.bottomRight,
    lastOrgCreditRadii.topLeft,
    lastOrgCreditRadii.bottomLeft,
  ]).toEqual(["0px", "0px", "0px", "0px"]);
});

async function enableUsagePackPlans(page: Page): Promise<void> {
  await page.route("**/api/okou/feature-switches", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.effectiveSwitches)) {
      throw new Error("Feature switches returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        effectiveSwitches: {
          ...body.effectiveSwitches,
          usagePackPlans: true,
        },
      },
    });
  });
}

async function mockCreditBalance(page: Page): Promise<void> {
  await page.route("**/api/okou/billing/status", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error("Billing status returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        tier: "pro",
        credits: 12_000,
        creditBreakdown: [
          {
            category: "plan",
            tier: "pro",
            label: "Pro credits",
            credits: 8000,
          },
          {
            category: "payAsYouGo",
            label: "Purchased credits",
            credits: 4000,
          },
        ],
        creditGrants: [],
        usageAllowance: {
          windows: [
            {
              kind: "short",
              windowSeconds: 18_000,
              unitLimit: 5000,
              consumedUnits: 1250,
              remainingUnits: 3750,
              startsAt: "2026-03-01T00:00:00Z",
              expiresAt: "2026-03-01T05:00:00Z",
            },
          ],
        },
      },
    });
  });
}

async function renderedCornerRadii(locator: Locator): Promise<{
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomRight: string;
  readonly bottomLeft: string;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      topLeft: style.borderTopLeftRadius,
      topRight: style.borderTopRightRadius,
      bottomRight: style.borderBottomRightRadius,
      bottomLeft: style.borderBottomLeftRadius,
    };
  });
}

async function expectLimitedFreeBillingStatus(page: Page): Promise<void> {
  const token = await currentClerkSessionToken(page);
  const response = await page.request.get(`${apiUrl}/api/okou/billing/status`, {
    headers: authHeadersForToken(token),
  });
  if (response.status() !== 200) {
    throw new Error(
      `billing status failed with ${response.status()}: ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();
  if (!hasBillingTier(body)) {
    throw new Error(
      `Unexpected billing status response: ${JSON.stringify(body)}`,
    );
  }
  expect(body.tier).toBe("limited-free-1");
}

async function currentClerkSessionToken(page: Page): Promise<string> {
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });
  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable");
  }
  return token;
}

function hasBillingTier(value: unknown): value is { readonly tier: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tier" in value &&
    typeof value.tier === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
