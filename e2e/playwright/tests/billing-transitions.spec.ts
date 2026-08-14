import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import {
  refreshClerkSessionToken,
  signInWithClerkTestingHelper,
} from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  authHeadersForToken,
  completeExploreOnboarding,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

type PaidTier = "pro" | "team";
type UsagePackUsd = 20 | 50 | 100 | 200;

interface BillingOwner {
  readonly organizationId: string;
  readonly userId: string;
}

interface ScheduledPlanChangeSummary {
  readonly targetTier: string | null;
  readonly type: string;
}

interface ConcurrencySubscriptionSummary {
  readonly cancelAtPeriodEnd: boolean;
  readonly quantity: number;
  readonly scheduledQuantity: number | null;
}

interface BillingSummary {
  readonly cancelAtPeriodEnd: boolean;
  readonly canBuyConcurrency: boolean;
  readonly concurrencyLimit: number;
  readonly concurrencyPurchaseReviewAvailable: boolean;
  readonly concurrencySubscriptions: readonly ConcurrencySubscriptionSummary[];
  readonly hasSubscription: boolean;
  readonly scheduledChange: ScheduledPlanChangeSummary | null;
  readonly tier: string;
}

interface UsagePackPendingChangeSummary {
  readonly kind: string;
  readonly status: string;
  readonly targetUsagePackUsd: number | null;
}

interface UsagePackSummary {
  readonly pendingChange: UsagePackPendingChangeSummary | null;
  readonly tier: string;
  readonly usagePackUsd: number;
}

const apiUrl = process.env.VM0_API_BACKEND_URL!;
const appUrl = deriveAppUrl(apiUrl);
const appOrigin = new URL(appUrl).origin;
const STATE_TIMEOUT_MS = 60_000;
const POLL_INTERVALS_MS = [500, 1_000, 2_000];
const USAGE_PACK_OPTION_PATTERNS: Readonly<Record<UsagePackUsd, RegExp>> = {
  20: /^\$20(?:\s|·)/u,
  50: /^\$50(?:\s|·)/u,
  100: /^\$100(?:\s|·)/u,
  200: /^\$200(?:\s|·)/u,
};

test.describe.configure({ mode: "parallel" });

test("usage-pack and Plan transitions preserve scheduled intent", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(page, "E2E Usage Pack Transitions", async (owner) => {
    let token = await buyUsagePackPlan(page, owner, "pro");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "pro",
    });
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 20,
    });

    token = await changeUsagePack(page, owner, "pro", 200, "Confirm", true);
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 200,
    });

    token = await changeUsagePack(page, owner, "pro", 20, "Confirm");
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: {
        kind: "downgrade",
        status: "scheduled",
        targetUsagePackUsd: 20,
      },
      tier: "pro",
      usagePackUsd: 200,
    });

    token = await changeUsagePack(page, owner, "pro", 100, "Confirm");
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: {
        kind: "downgrade",
        status: "scheduled",
        targetUsagePackUsd: 100,
      },
      tier: "pro",
      usagePackUsd: 200,
    });

    token = await changeUsagePack(page, owner, "pro", 200, "Restore");
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 200,
    });

    token = await cancelPlan(page, owner, "pro");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "pro",
    });

    token = await restorePlan(page, owner, "pro");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "pro",
    });

    token = await upgradeProToTeam(page, owner);
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: null,
      tier: "team",
      usagePackUsd: 200,
    });

    token = await cancelPlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "team",
    });

    token = await restorePlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });

    token = await downgradeTeamToPro(page, owner);
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: { targetTier: "pro", type: "downgrade" },
      tier: "team",
    });

    token = await restorePlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });

    token = await cancelPlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "team",
    });

    token = await replaceTeamCancellationWithPro(page, owner);
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: { targetTier: "pro", type: "downgrade" },
      tier: "team",
    });

    token = await restorePlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectUsagePackState(page, token, owner.userId, {
      pendingChange: null,
      tier: "team",
      usagePackUsd: 200,
    });
  });
});

test("concurrency transitions handle schedules, cancellation, and restoration", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(page, "E2E Concurrency Transitions", async (owner) => {
    let token = await buyUsagePackPlan(page, owner, "team");
    await expectPlanState(page, token, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: null,
      concurrencyLimit: 10,
      quantity: null,
      scheduledQuantity: null,
      subscriptionCount: 0,
    });

    token = await buyConcurrency(page, owner, 5);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 15,
      quantity: 5,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    token = await changeConcurrency(page, owner, 1);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 15,
      quantity: 5,
      scheduledQuantity: 1,
      subscriptionCount: 1,
    });

    token = await changeConcurrency(page, owner, 3);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 15,
      quantity: 5,
      scheduledQuantity: 3,
      subscriptionCount: 1,
    });

    token = await changeConcurrency(page, owner, 6);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 16,
      quantity: 6,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    token = await cancelConcurrency(page, owner);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: true,
      concurrencyLimit: 16,
      quantity: 6,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    token = await restoreConcurrency(page, owner);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 16,
      quantity: 6,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    token = await changeConcurrency(page, owner, 10);
    await expectConcurrencyState(page, token, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });
  });
});

async function withBillingOwner(
  page: Page,
  organizationName: string,
  run: (owner: BillingOwner) => Promise<void>,
): Promise<void> {
  const email = generateTestEmail("paid-onboarding");
  let organizationId: string | undefined;

  try {
    const userId = await createUser(email);
    organizationId = await createOrganization(
      organizationName,
      userId,
      "paid-onboarding",
    );
    await signInWithClerkTestingHelper(page, email, appUrl, {
      activeOrganizationId: organizationId,
    });
    await completeExploreOnboarding(page, { appUrl });
    const token = await currentToken(page, organizationId);
    await enableUsagePackPlans(page, token);
    await run({ organizationId, userId });
  } finally {
    await deleteClerkTestOwnerResources(
      email,
      organizationId,
      "paid-onboarding",
    );
  }
}

async function enableUsagePackPlans(page: Page, token: string): Promise<void> {
  const response = await page.request.post(
    `${apiUrl}/api/okou/feature-switches`,
    {
      data: { switches: { usagePackPlans: true } },
      headers: authHeadersForToken(token),
    },
  );
  if (response.status() !== 200) {
    throw new Error(
      `feature switch update failed with ${response.status()}: ${await response.text()}`,
    );
  }
  const body: unknown = await response.json();
  const responseBody = requireRecord(body, "feature switch response");
  const effectiveSwitches = requireRecord(
    responseBody.effectiveSwitches,
    "effective feature switches",
  );
  if (effectiveSwitches.usagePackPlans !== true) {
    throw new Error("usagePackPlans was not enabled for the billing E2E owner");
  }
}

async function buyUsagePackPlan(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
): Promise<string> {
  const planLabel = tier === "pro" ? "Pro" : "Team";
  const settings = await openBillingSettings(page);
  await expect(
    settings.getByText("No active plan", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Upgrade", exact: true }).click();

  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  await expect(choosePlan).toBeVisible();
  const plan = choosePlan.getByRole("article", { name: `${planLabel} plan` });
  await plan
    .getByRole("button", { name: `Start with ${planLabel}`, exact: true })
    .click();

  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  await expect(
    packages.getByRole("combobox", { name: /^Usage for /u }),
  ).toBeVisible();
  const summary = packages.getByRole("region", { name: "Order summary" });
  await summary
    .getByRole("button", { name: `Upgrade to ${planLabel}`, exact: true })
    .click();

  await fillStripeCheckout(page);
  await page.waitForURL((url) => url.origin === appOrigin, {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  return await currentToken(page, owner.organizationId);
}

async function changeUsagePack(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
  target: UsagePackUsd,
  action: "Confirm" | "Restore",
  cancelReviewOnce = false,
): Promise<string> {
  const packages = await openUsagePackManagement(page, tier);
  await selectUsagePack(page, packages, target);
  return await submitUsagePackConfiguration(
    page,
    owner,
    packages,
    action,
    cancelReviewOnce,
  );
}

async function openUsagePackManagement(
  page: Page,
  tier: PaidTier,
): Promise<Locator> {
  const planLabel = tier === "pro" ? "Pro" : "Team";
  const settings = await openBillingSettings(page);
  await expect(
    settings.getByText(`${planLabel} plan`, { exact: true }).first(),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Compare all plans", exact: true })
    .click();
  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  const plan = choosePlan.getByRole("article", { name: `${planLabel} plan` });
  await plan.getByRole("button", { name: "Manage", exact: true }).click();
  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  return packages;
}

async function selectUsagePack(
  page: Page,
  packages: Locator,
  target: UsagePackUsd,
): Promise<void> {
  const select = packages.getByRole("combobox", { name: /^Usage for /u });
  await select.click();
  await page
    .getByRole("option", { name: USAGE_PACK_OPTION_PATTERNS[target] })
    .click();
}

async function submitUsagePackConfiguration(
  page: Page,
  owner: BillingOwner,
  packages: Locator,
  action: "Confirm" | "Restore",
  cancelReviewOnce = false,
): Promise<string> {
  const summary = packages.getByRole("region", { name: "Order summary" });
  const actionButton = summary.getByRole("button", {
    name: action,
    exact: true,
  });
  await expect(actionButton).toBeEnabled();
  await actionButton.click();

  let review = page.getByRole("dialog", { name: "Review package change" });
  await expect(review).toBeVisible();
  if (cancelReviewOnce) {
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(actionButton).toBeEnabled();
    await actionButton.click();
    review = page.getByRole("dialog", { name: "Review package change" });
    await expect(review).toBeVisible();
  }

  const token = await currentToken(page, owner.organizationId);
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  return token;
}

async function cancelPlan(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
): Promise<string> {
  const settings = await openBillingSettings(page);
  const planLabel = tier === "pro" ? "Pro" : "Team";
  await expect(
    settings.getByText(`${planLabel} plan`, { exact: true }).first(),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Downgrade", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Downgrade plan" });
  await expect(dialog).toBeVisible();
  if (tier === "team") {
    await dialog.getByRole("button", { name: /^No plan/u }).click();
  }
  const token = await currentToken(page, owner.organizationId);
  await dialog
    .getByRole("button", { name: "Cancel subscription", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return token;
}

async function restorePlan(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
): Promise<string> {
  const settings = await openBillingSettings(page);
  const restore = settings.getByRole("button", {
    name: "Restore plan",
    exact: true,
  });
  await expect(restore).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Upgrade", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Downgrade", exact: true }),
  ).toHaveCount(0);
  await restore.click();

  const planLabel = tier === "pro" ? "Pro" : "Team";
  const dialog = page.getByRole("dialog", {
    name: `Restore ${planLabel} plan?`,
  });
  const token = await currentToken(page, owner.organizationId);
  await dialog
    .getByRole("button", { name: "Restore plan", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return token;
}

async function upgradeProToTeam(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Upgrade", exact: true }).click();
  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  return await submitUsagePackConfiguration(page, owner, packages, "Confirm");
}

async function downgradeTeamToPro(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await settings
    .getByRole("button", { name: "Compare all plans", exact: true })
    .click();
  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  const pro = choosePlan.getByRole("article", { name: "Pro plan" });
  await pro.getByRole("button", { name: "Downgrade", exact: true }).click();
  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  return await submitUsagePackConfiguration(page, owner, packages, "Confirm");
}

async function replaceTeamCancellationWithPro(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await settings
    .getByRole("button", { name: "Compare all plans", exact: true })
    .click();
  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  const pro = choosePlan.getByRole("article", { name: "Pro plan" });
  await pro.getByRole("button", { name: "Downgrade", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Downgrade plan" });
  await expect(dialog).toBeVisible();
  const token = await currentToken(page, owner.organizationId);
  await dialog
    .getByRole("button", { name: "Downgrade to Pro", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return token;
}

async function buyConcurrency(
  page: Page,
  owner: BillingOwner,
  quantity: number,
): Promise<string> {
  const token = await currentToken(page, owner.organizationId);
  const initial = await readBillingSummary(page, token);
  expect(initial.canBuyConcurrency).toBe(true);
  expect(initial.concurrencyPurchaseReviewAvailable).toBe(true);

  const settings = await openBillingSettings(page);
  await settings
    .getByRole("button", { name: "Buy concurrency", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Buy concurrency" });
  const increase = dialog.getByRole("button", {
    name: "Increase additional concurrency quantity",
  });
  for (let current = 1; current < quantity; current += 1) {
    await increase.click();
  }
  await dialog
    .getByRole("button", {
      name: `Buy $${quantity * 100}/month`,
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Confirm", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const confirmationToken = await currentToken(page, owner.organizationId);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return confirmationToken;
}

async function changeConcurrency(
  page: Page,
  owner: BillingOwner,
  targetQuantity: number,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change concurrency" });
  const input = dialog.getByLabel("New total slot quantity");
  const reviewButton = dialog.getByRole("button", {
    name: "Review change",
    exact: true,
  });
  await expect(reviewButton).toBeDisabled();
  await input.fill(String(targetQuantity));
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();

  const review = page.getByRole("dialog", {
    name: "Review concurrency change",
  });
  await expect(review).toBeVisible({ timeout: 30_000 });
  const token = await currentToken(page, owner.organizationId);
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  return token;
}

async function cancelConcurrency(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change concurrency" });
  await dialog
    .getByRole("radio", { name: /Cancel entire subscription/u })
    .click();
  const token = await currentToken(page, owner.organizationId);
  await dialog
    .getByRole("button", { name: "Cancel subscription", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return token;
}

async function restoreConcurrency(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const settings = await openBillingSettings(page);
  await expect(
    settings.getByRole("button", { name: "Change", exact: true }),
  ).toHaveCount(0);
  const restore = settings.getByRole("button", {
    name: "Restore",
    exact: true,
  });
  await expect(restore).toBeVisible();
  await restore.click();
  const dialog = page.getByRole("dialog", {
    name: "Restore concurrency subscription?",
  });
  const token = await currentToken(page, owner.organizationId);
  await dialog
    .getByRole("button", { name: "Restore subscription", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  return token;
}

async function openBillingSettings(page: Page): Promise<Locator> {
  await page.goto(new URL("/?settings=billing", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  return settings;
}

async function currentToken(
  page: Page,
  organizationId: string,
): Promise<string> {
  return await refreshClerkSessionToken(page, {
    activeOrganizationId: organizationId,
  });
}

async function expectPlanState(
  page: Page,
  token: string,
  expected: {
    readonly cancelAtPeriodEnd: boolean;
    readonly hasSubscription: boolean;
    readonly scheduledChange: ScheduledPlanChangeSummary | null;
    readonly tier: string;
  },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await pollSafely(async () => {
          return await readBillingSummary(page, token);
        });
        if ("pollingError" in state) {
          return state;
        }
        return {
          cancelAtPeriodEnd: state.cancelAtPeriodEnd,
          hasSubscription: state.hasSubscription,
          scheduledChange: state.scheduledChange,
          tier: state.tier,
        };
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `billing Plan state should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectUsagePackState(
  page: Page,
  token: string,
  memberId: string,
  expected: UsagePackSummary,
): Promise<void> {
  await expect
    .poll(
      async () => {
        return await pollSafely(async () => {
          return await readUsagePackSummary(page, token, memberId);
        });
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `usage-pack state should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectConcurrencyState(
  page: Page,
  token: string,
  expected: {
    readonly cancelAtPeriodEnd: boolean | null;
    readonly concurrencyLimit: number;
    readonly quantity: number | null;
    readonly scheduledQuantity: number | null;
    readonly subscriptionCount: number;
  },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await pollSafely(async () => {
          return await readBillingSummary(page, token);
        });
        if ("pollingError" in state) {
          return state;
        }
        const subscription = state.concurrencySubscriptions[0] ?? null;
        return {
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? null,
          concurrencyLimit: state.concurrencyLimit,
          quantity: subscription?.quantity ?? null,
          scheduledQuantity: subscription?.scheduledQuantity ?? null,
          subscriptionCount: state.concurrencySubscriptions.length,
        };
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `concurrency state should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function pollSafely<T>(
  read: () => Promise<T>,
): Promise<T | { readonly pollingError: string }> {
  try {
    return await read();
  } catch (error) {
    return {
      pollingError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readBillingSummary(
  page: Page,
  token: string,
): Promise<BillingSummary> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/billing/status", token),
    "billing status",
  );
  const scheduledChange = parseScheduledPlanChange(body.scheduledChange);
  const subscriptions = requireArray(
    body.concurrencySubscriptions,
    "billing concurrency subscriptions",
  ).map((value, index) => {
    const subscription = requireRecord(
      value,
      `billing concurrency subscription ${index}`,
    );
    return {
      cancelAtPeriodEnd: requireBoolean(
        subscription.cancelAtPeriodEnd,
        "concurrency cancelAtPeriodEnd",
      ),
      quantity: requireNumber(subscription.quantity, "concurrency quantity"),
      scheduledQuantity: optionalNullableNumber(
        subscription.scheduledQuantity,
        "concurrency scheduledQuantity",
      ),
    };
  });

  return {
    cancelAtPeriodEnd: requireBoolean(
      body.cancelAtPeriodEnd,
      "billing cancelAtPeriodEnd",
    ),
    canBuyConcurrency: optionalBoolean(
      body.canBuyConcurrency,
      "billing canBuyConcurrency",
    ),
    concurrencyLimit: requireNumber(
      body.concurrencyLimit,
      "billing concurrencyLimit",
    ),
    concurrencyPurchaseReviewAvailable: optionalBoolean(
      body.concurrencyPurchaseReviewAvailable,
      "billing concurrencyPurchaseReviewAvailable",
    ),
    concurrencySubscriptions: subscriptions,
    hasSubscription: requireBoolean(
      body.hasSubscription,
      "billing hasSubscription",
    ),
    scheduledChange,
    tier: requireString(body.tier, "billing tier"),
  };
}

async function readUsagePackSummary(
  page: Page,
  token: string,
  memberId: string,
): Promise<UsagePackSummary> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/billing/usage-pack-subscription", token),
    "usage-pack management",
  );
  const allocation = requireArray(body.allocations, "usage-pack allocations")
    .map((value, index) => {
      return requireRecord(value, `usage-pack allocation ${index}`);
    })
    .find((value) => value.memberId === memberId);
  if (!allocation) {
    throw new Error(`usage-pack allocation for member ${memberId} not found`);
  }

  return {
    pendingChange: parseUsagePackPendingChange(allocation.pendingChange),
    tier: requireString(body.tier, "usage-pack tier"),
    usagePackUsd: requireNumber(
      allocation.usagePackUsd,
      "usage-pack allocation amount",
    ),
  };
}

async function getApiJson(
  page: Page,
  path: string,
  token: string,
): Promise<unknown> {
  const response = await page.request.get(new URL(path, apiUrl).toString(), {
    headers: authHeadersForToken(token),
  });
  if (response.status() !== 200) {
    throw new Error(
      `${path} failed with ${response.status()}: ${await response.text()}`,
    );
  }
  const body: unknown = await response.json();
  return body;
}

function parseScheduledPlanChange(
  value: unknown,
): ScheduledPlanChangeSummary | null {
  if (value === null) {
    return null;
  }
  const change = requireRecord(value, "scheduled Plan change");
  return {
    targetTier: optionalNullableString(
      change.targetTier,
      "scheduled Plan targetTier",
    ),
    type: requireString(change.type, "scheduled Plan change type"),
  };
}

function parseUsagePackPendingChange(
  value: unknown,
): UsagePackPendingChangeSummary | null {
  if (value === null) {
    return null;
  }
  const change = requireRecord(value, "usage-pack pending change");
  return {
    kind: requireString(change.kind, "usage-pack pending change kind"),
    status: requireString(change.status, "usage-pack pending change status"),
    targetUsagePackUsd: optionalNullableNumber(
      change.targetUsagePackUsd,
      "usage-pack pending target",
    ),
  };
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} is not an array`);
  }
  return value;
}

function requireBoolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${description} is not a boolean`);
  }
  return value;
}

function optionalBoolean(value: unknown, description: string): boolean {
  if (value === undefined) {
    return false;
  }
  return requireBoolean(value, description);
}

function requireNumber(value: unknown, description: string): number {
  if (typeof value !== "number") {
    throw new Error(`${description} is not a number`);
  }
  return value;
}

function optionalNullableNumber(
  value: unknown,
  description: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireNumber(value, description);
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new Error(`${description} is not a string`);
  }
  return value;
}

function optionalNullableString(
  value: unknown,
  description: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, description);
}
