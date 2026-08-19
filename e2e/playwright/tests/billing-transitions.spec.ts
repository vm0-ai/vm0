import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import {
  getCurrentClerkSessionToken,
  type ClerkSessionTokenCache,
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
  readonly session: ClerkSessionTokenCache;
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

interface UsagePackCreditSummary {
  readonly bonusCredits: number;
  readonly hasUsagePack: boolean;
  readonly memberTotalCredits: number;
  readonly purchasedCredits: number;
  readonly totalCredits: number;
}

interface PendingInvitationSummary {
  readonly email: string;
  readonly role: string;
  readonly usagePackUsd: number;
}

const apiUrl = process.env.VM0_API_BACKEND_URL!;
const appUrl = deriveAppUrl(apiUrl);
const appOrigin = new URL(appUrl).origin;
const STATE_TIMEOUT_MS = 60_000;
const TOKEN_REUSE_MS = 30_000;
const POLL_INTERVALS_MS = [500, 1_000, 2_000];
const USAGE_PACK_PLAN_ENDING_MESSAGE =
  "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.";
const CONCURRENCY_PLAN_ENDING_MESSAGE =
  "Your Plan is scheduled to end before this concurrency reduction can take effect. Restore your Plan first, then try again.";
const USAGE_PACK_OPTION_PATTERNS: Readonly<Record<UsagePackUsd, RegExp>> = {
  20: /^\$20(?:\s|·)/u,
  50: /^\$50(?:\s|·)/u,
  100: /^\$100(?:\s|·)/u,
  200: /^\$200(?:\s|·)/u,
};
const ACTIVE_TEAM_PLAN_STATE = {
  cancelAtPeriodEnd: false,
  hasSubscription: true,
  scheduledChange: null,
  tier: "team",
} as const;
const ENDING_TEAM_PLAN_STATE = {
  cancelAtPeriodEnd: true,
  hasSubscription: true,
  scheduledChange: { targetTier: "limited-free-1", type: "cancel" },
  tier: "team",
} as const;
const DOWNGRADING_TEAM_PLAN_STATE = {
  cancelAtPeriodEnd: false,
  hasSubscription: true,
  scheduledChange: { targetTier: "pro", type: "downgrade" },
  tier: "team",
} as const;

test.describe.configure({ mode: "parallel" });

test("usage-pack and Plan transitions preserve scheduled intent", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(page, "E2E Usage Pack Transitions", async (owner) => {
    await buyUsagePackPlan(page, "pro");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "pro",
    });
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 20,
    });

    await changeUsagePack(page, "pro", 200, "Confirm", true);
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 200,
    });

    await changeUsagePack(page, "pro", 20, "Confirm");
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: {
        kind: "downgrade",
        status: "scheduled",
        targetUsagePackUsd: 20,
      },
      tier: "pro",
      usagePackUsd: 200,
    });

    await changeUsagePack(page, "pro", 100, "Confirm");
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: {
        kind: "downgrade",
        status: "scheduled",
        targetUsagePackUsd: 100,
      },
      tier: "pro",
      usagePackUsd: 200,
    });

    await changeUsagePack(page, "pro", 200, "Restore");
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 200,
    });

    await cancelPlan(page, "pro");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "pro",
    });

    await restorePlan(page, "pro");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "pro",
    });

    await upgradeProToTeam(page);
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "team",
      usagePackUsd: 200,
    });

    await cancelPlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "team",
    });

    await restorePlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });

    await downgradeTeamToPro(page);
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: { targetTier: "pro", type: "downgrade" },
      tier: "team",
    });

    await restorePlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });

    await cancelPlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        targetTier: "limited-free-1",
        type: "cancel",
      },
      tier: "team",
    });

    await replaceTeamCancellationWithPro(page);
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: { targetTier: "pro", type: "downgrade" },
      tier: "team",
    });

    await restorePlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "team",
      usagePackUsd: 200,
    });
  });
});

test("restored Team plan preserves package and concurrency changes", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(
    page,
    "E2E Combined Billing Transitions",
    async (owner) => {
      await buyUsagePackPlan(page, "team", 100);
      await expectPlanState(page, owner, {
        cancelAtPeriodEnd: false,
        hasSubscription: true,
        scheduledChange: null,
        tier: "team",
      });
      await expectUsagePackState(page, owner, owner.userId, {
        pendingChange: null,
        tier: "team",
        usagePackUsd: 100,
      });
      await expectConcurrencyState(page, owner, {
        cancelAtPeriodEnd: null,
        concurrencyLimit: 10,
        quantity: null,
        scheduledQuantity: null,
        subscriptionCount: 0,
      });

      await buyConcurrency(page, owner, 10);
      await expectConcurrencyState(page, owner, {
        cancelAtPeriodEnd: false,
        concurrencyLimit: 20,
        quantity: 10,
        scheduledQuantity: null,
        subscriptionCount: 1,
      });

      const upgradePackages = await openUsagePackManagement(page, "team");
      await selectUsagePack(page, upgradePackages, 200);
      const controlPage = await page.context().newPage();
      try {
        await cancelPlan(controlPage, "team");
        await expectPlanState(page, owner, ENDING_TEAM_PLAN_STATE);

        await submitUsagePackConfiguration(page, upgradePackages, "Confirm");
        await expectUsagePackState(page, owner, owner.userId, {
          pendingChange: null,
          tier: "team",
          usagePackUsd: 200,
        });
        await expectPlanState(page, owner, ENDING_TEAM_PLAN_STATE);
        await expectUsagePackReductionRejectedWhilePlanEnds(
          page,
          upgradePackages,
          100,
        );
        await expectUsagePackState(page, owner, owner.userId, {
          pendingChange: null,
          tier: "team",
          usagePackUsd: 200,
        });

        await restorePlan(page, "team");
        await expectPlanState(page, owner, ACTIVE_TEAM_PLAN_STATE);
        await changeUsagePack(page, "team", 50, "Confirm");
        await expectUsagePackState(page, owner, owner.userId, {
          pendingChange: {
            kind: "downgrade",
            status: "scheduled",
            targetUsagePackUsd: 50,
          },
          tier: "team",
          usagePackUsd: 200,
        });

        await changeConcurrency(page, 5);
        await expectConcurrencyState(page, owner, {
          cancelAtPeriodEnd: false,
          concurrencyLimit: 20,
          quantity: 10,
          scheduledQuantity: 5,
          subscriptionCount: 1,
        });

        const restorePackages = await openUsagePackManagement(page, "team");
        await selectUsagePack(page, restorePackages, 200);
        await downgradeTeamToPro(controlPage);
        await expectPlanState(page, owner, DOWNGRADING_TEAM_PLAN_STATE);

        await submitUsagePackConfiguration(page, restorePackages, "Restore");
        await expectUsagePackState(page, owner, owner.userId, {
          pendingChange: null,
          tier: "team",
          usagePackUsd: 200,
        });
        await expectConcurrencyState(page, owner, {
          cancelAtPeriodEnd: false,
          concurrencyLimit: 20,
          quantity: 10,
          scheduledQuantity: 5,
          subscriptionCount: 1,
        });
        await expectPlanState(page, owner, DOWNGRADING_TEAM_PLAN_STATE);

        await restoreConcurrency(page);
        await expectConcurrencyState(page, owner, {
          cancelAtPeriodEnd: false,
          concurrencyLimit: 20,
          quantity: 10,
          scheduledQuantity: null,
          subscriptionCount: 1,
        });
        await expectUsagePackState(page, owner, owner.userId, {
          pendingChange: null,
          tier: "team",
          usagePackUsd: 200,
        });
        await expectPlanState(page, owner, DOWNGRADING_TEAM_PLAN_STATE);
      } finally {
        await controlPage.close();
      }
    },
  );
});

test("paid invitations charge one package each and revoke pending packages", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(page, "E2E Paid Member Invitation", async (owner) => {
    const firstInviteeEmail = generateTestEmail("paid-onboarding");
    const secondInviteeEmail = generateTestEmail("paid-onboarding");
    await buyUsagePackPlan(page, "pro");
    await expectUsagePackState(page, owner, owner.userId, {
      pendingChange: null,
      tier: "pro",
      usagePackUsd: 20,
    });
    await expectUsagePackCreditState(page, owner, owner.userId, {
      bonusCredits: 400,
      hasUsagePack: true,
      memberTotalCredits: 20_400,
      purchasedCredits: 20_000,
      totalCredits: 20_400,
    });
    await expectUsagePackCreditsUi(page);

    const firstAmountCents = await purchasePaidInvitation(
      page,
      firstInviteeEmail,
      20,
    );
    await expectPendingInvitationState(page, owner, firstInviteeEmail, {
      email: firstInviteeEmail,
      role: "member",
      usagePackUsd: 20,
    });

    const secondAmountCents = await purchasePaidInvitation(
      page,
      secondInviteeEmail,
      20,
    );
    await expectPendingInvitationState(page, owner, secondInviteeEmail, {
      email: secondInviteeEmail,
      role: "member",
      usagePackUsd: 20,
    });
    expect(Math.abs(secondAmountCents - firstAmountCents)).toBeLessThanOrEqual(
      1,
    );

    await revokePaidInvitation(page, firstInviteeEmail);
    await expectPendingInvitationState(page, owner, firstInviteeEmail, null);
    await revokePaidInvitation(page, secondInviteeEmail);
    await expectPendingInvitationState(page, owner, secondInviteeEmail, null);
  });
});

test("concurrency transitions handle schedules, cancellation, and restoration", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(page, "E2E Concurrency Transitions", async (owner) => {
    await buyUsagePackPlan(page, "team");
    await expectPlanState(page, owner, {
      cancelAtPeriodEnd: false,
      hasSubscription: true,
      scheduledChange: null,
      tier: "team",
    });
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: null,
      concurrencyLimit: 10,
      quantity: null,
      scheduledQuantity: null,
      subscriptionCount: 0,
    });

    await buyConcurrency(page, owner, 5);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 15,
      quantity: 5,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    await cancelPlan(page, "team");
    await changeConcurrency(page, 10);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });
    await expectPlanState(page, owner, ENDING_TEAM_PLAN_STATE);
    await expectConcurrencyReductionRejectedWhilePlanEnds(page, 5);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    await restorePlan(page, "team");
    await expectPlanState(page, owner, ACTIVE_TEAM_PLAN_STATE);

    await changeConcurrency(page, 1);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: 1,
      subscriptionCount: 1,
    });

    await changeConcurrency(page, 3);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: 3,
      subscriptionCount: 1,
    });

    await restoreConcurrency(page);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: false,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    await cancelConcurrency(page);
    await expectConcurrencyState(page, owner, {
      cancelAtPeriodEnd: true,
      concurrencyLimit: 20,
      quantity: 10,
      scheduledQuantity: null,
      subscriptionCount: 1,
    });

    await restoreConcurrency(page);
    await expectConcurrencyState(page, owner, {
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
    const token = await signInWithClerkTestingHelper(page, email, appUrl, {
      activeOrganizationId: organizationId,
      preserveAppPage: true,
    });
    const owner: BillingOwner = {
      organizationId,
      session: { refreshedAt: Date.now(), token },
      userId,
    };
    await completeExploreOnboarding(page, { appUrl });
    await enableUsagePackPlans(page, await currentToken(page, owner));
    await run(owner);
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
  tier: PaidTier,
  usagePackUsd?: UsagePackUsd,
): Promise<void> {
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
  await expect(packages).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  await expect(
    packages.getByRole("combobox", { name: /^Usage for /u }),
  ).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  if (usagePackUsd !== undefined) {
    await selectUsagePack(page, packages, usagePackUsd);
  }
  const summary = packages.getByRole("region", { name: "Order summary" });
  await summary
    .getByRole("button", { name: `Upgrade to ${planLabel}`, exact: true })
    .click();

  await fillStripeCheckout(page);
  await page.waitForURL((url) => url.origin === appOrigin, {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
}

async function expectUsagePackCreditsUi(page: Page): Promise<void> {
  await page.goto(new URL("/?settings=usage", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const card = page.getByTestId("usage-pack-credit-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(
    card.getByText("Usage pack credits", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("20,400", { exact: true }).first()).toBeVisible();
  await expect(
    card.getByTestId("usage-pack-credit-purchased"),
  ).toHaveAccessibleName(/^Purchased — 20,000\./u);
  await expect(
    card.getByTestId("usage-pack-credit-bonus"),
  ).toHaveAccessibleName(/^Bonus — 400\./u);
}

async function purchasePaidInvitation(
  page: Page,
  email: string,
  usagePackUsd: UsagePackUsd,
): Promise<number> {
  const settings = await openPeopleSettings(page);
  await settings
    .getByRole("button", { name: "Add member", exact: true })
    .click();
  const invite = page.getByRole("dialog", { name: "Invite member" });
  await invite.getByPlaceholder("email@example.com").fill(email);
  const packageField = invite
    .getByText("Member packages", { exact: true })
    .locator("..");
  await packageField.getByRole("combobox").click();
  await page
    .getByRole("option", { name: USAGE_PACK_OPTION_PATTERNS[usagePackUsd] })
    .click();
  const previewResponsePromise = page.waitForResponse(
    (response) => {
      return (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          "/api/okou/org/invite/purchase/preview"
      );
    },
    { timeout: STATE_TIMEOUT_MS },
  );
  await invite.getByRole("button", { name: "Continue", exact: true }).click();
  const previewResponse = await previewResponsePromise;
  expect(previewResponse.status()).toBe(200);
  const previewBody = requireRecord(
    await previewResponse.json(),
    "invitation purchase preview",
  );
  const immediateAmountCents = requireNumber(
    previewBody.immediateAmountCents,
    "invitation purchase amount",
  );
  expect(immediateAmountCents).toBeGreaterThan(0);
  expect(immediateAmountCents).toBeLessThanOrEqual(usagePackUsd * 100);

  const review = page.getByRole("dialog", { name: "Review invitation" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(email, { exact: true })).toBeVisible();
  await expect(review.getByText(/^Member · /u)).toBeVisible();
  await expect(
    review.getByText(`$${(immediateAmountCents / 100).toFixed(2)}`, {
      exact: true,
    }),
  ).toBeVisible();
  const responsePromise = page.waitForResponse(
    (response) => {
      return (
        response.request().method() === "POST" &&
        /^\/api\/okou\/org\/invite\/purchase\/[^/]+\/confirm$/u.test(
          new URL(response.url()).pathname,
        )
      );
    },
    { timeout: STATE_TIMEOUT_MS },
  );
  await review
    .getByRole("button", { name: "Pay and invite", exact: true })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(review).toBeHidden({ timeout: 30_000 });

  const row = pendingInvitationRow(settings, email);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(
    row.getByText(`$${usagePackUsd}/month`, { exact: true }),
  ).toBeVisible();
  await expect(row.getByText("Pending", { exact: true })).toBeVisible();
  return immediateAmountCents;
}

async function revokePaidInvitation(page: Page, email: string): Promise<void> {
  const settings = await openPeopleSettings(page);
  const row = pendingInvitationRow(settings, email);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: `Actions for ${email}` }).click();
  await page
    .getByRole("menuitem", { name: "Revoke invitation", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Revoke invitation?" });
  await expect(dialog).toBeVisible();
  const responsePromise = page.waitForResponse(
    (response) => {
      return (
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/okou/org/invite"
      );
    },
    { timeout: STATE_TIMEOUT_MS },
  );
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(pendingInvitationRow(settings, email)).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function openPeopleSettings(page: Page): Promise<Locator> {
  await page.goto(new URL("/?settings=people", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await expect(
    settings.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  return settings;
}

function pendingInvitationRow(settings: Locator, email: string): Locator {
  return settings
    .getByText(email, { exact: true })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' grid ')][1]",
    );
}

async function changeUsagePack(
  page: Page,
  tier: PaidTier,
  target: UsagePackUsd,
  action: "Confirm" | "Restore",
  backFromReviewOnce = false,
): Promise<void> {
  const packages = await openUsagePackManagement(page, tier);
  await selectUsagePack(page, packages, target);
  await submitUsagePackConfiguration(
    page,
    packages,
    action,
    backFromReviewOnce,
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
  await expect(packages).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  return packages;
}

async function selectUsagePack(
  page: Page,
  packages: Locator,
  target: UsagePackUsd,
): Promise<void> {
  const select = packages.getByRole("combobox", { name: /^Usage for /u });
  await expect(select).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  await select.click();
  await page
    .getByRole("option", { name: USAGE_PACK_OPTION_PATTERNS[target] })
    .click();
}

async function submitUsagePackConfiguration(
  page: Page,
  packages: Locator,
  action: "Confirm" | "Restore",
  backFromReviewOnce = false,
): Promise<void> {
  const summary = packages.getByRole("region", { name: "Order summary" });
  const actionButton = summary.getByRole("button", {
    name: action,
    exact: true,
  });
  await expect(actionButton).toBeEnabled({ timeout: STATE_TIMEOUT_MS });
  await actionButton.click();

  let review = page.getByRole("dialog", { name: "Review package change" });
  await expect(review).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  if (backFromReviewOnce) {
    await review.getByRole("button", { name: "Back", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(actionButton).toBeEnabled({ timeout: STATE_TIMEOUT_MS });
    await actionButton.click();
    review = page.getByRole("dialog", { name: "Review package change" });
    await expect(review).toBeVisible({ timeout: STATE_TIMEOUT_MS });
  }

  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

async function expectUsagePackReductionRejectedWhilePlanEnds(
  page: Page,
  packages: Locator,
  target: UsagePackUsd,
): Promise<void> {
  await selectUsagePack(page, packages, target);
  const summary = packages.getByRole("region", { name: "Order summary" });
  const confirm = summary.getByRole("button", {
    name: "Confirm",
    exact: true,
  });
  await expect(confirm).toBeEnabled({ timeout: STATE_TIMEOUT_MS });
  await confirm.click();
  await expect(
    page.getByText(USAGE_PACK_PLAN_ENDING_MESSAGE, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("dialog", { name: "Review package change" }),
  ).toHaveCount(0);
}

async function cancelPlan(page: Page, tier: PaidTier): Promise<void> {
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
  await dialog
    .getByRole("button", { name: "Cancel subscription", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function restorePlan(page: Page, tier: PaidTier): Promise<void> {
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
  await dialog
    .getByRole("button", { name: "Restore plan", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function upgradeProToTeam(page: Page): Promise<void> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Upgrade", exact: true }).click();
  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  await submitUsagePackConfiguration(page, packages, "Confirm");
}

async function downgradeTeamToPro(page: Page): Promise<void> {
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
  await submitUsagePackConfiguration(page, packages, "Confirm");
}

async function replaceTeamCancellationWithPro(page: Page): Promise<void> {
  const settings = await openBillingSettings(page);
  await settings
    .getByRole("button", { name: "Compare all plans", exact: true })
    .click();
  const choosePlan = page.getByRole("dialog", { name: "Choose a plan" });
  const pro = choosePlan.getByRole("article", { name: "Pro plan" });
  await pro.getByRole("button", { name: "Downgrade", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Downgrade plan" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Downgrade to Pro", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function buyConcurrency(
  page: Page,
  owner: BillingOwner,
  quantity: number,
): Promise<void> {
  const token = await currentToken(page, owner);
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
    .getByRole("button", { name: "Review purchase", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review concurrency purchase",
  });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review
    .getByRole("button", { name: "Pay and add slots", exact: true })
    .click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

async function changeConcurrency(
  page: Page,
  targetQuantity: number,
): Promise<void> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change concurrency" });
  const input = dialog.getByRole("textbox", { name: "Slots" });
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
  await review
    .getByRole("button", {
      name: /^(?:Pay and update|Schedule change|Update slots)$/u,
    })
    .click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

async function expectConcurrencyReductionRejectedWhilePlanEnds(
  page: Page,
  targetQuantity: number,
): Promise<void> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change concurrency" });
  const input = dialog.getByRole("textbox", { name: "Slots" });
  const reviewButton = dialog.getByRole("button", {
    name: "Review change",
    exact: true,
  });
  await input.fill(String(targetQuantity));
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();
  await expect(
    page.getByText(CONCURRENCY_PLAN_ENDING_MESSAGE, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
}

async function cancelConcurrency(page: Page): Promise<void> {
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Change", exact: true }).click();
  const changeDialog = page.getByRole("dialog", {
    name: "Change concurrency",
  });
  await changeDialog
    .getByRole("button", { name: "Cancel entire subscription", exact: true })
    .click();
  const cancelDialog = page.getByRole("dialog", {
    name: "Cancel entire subscription",
  });
  await cancelDialog
    .getByRole("button", { name: "Cancel subscription", exact: true })
    .click();
  await expect(cancelDialog).toBeHidden({ timeout: 30_000 });
}

async function restoreConcurrency(page: Page): Promise<void> {
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
  await dialog
    .getByRole("button", { name: "Restore subscription", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function openBillingSettings(page: Page): Promise<Locator> {
  await page.goto(new URL("/?settings=billing", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  return settings;
}

async function currentToken(page: Page, owner: BillingOwner): Promise<string> {
  return await getCurrentClerkSessionToken(page, owner.session, {
    activeOrganizationId: owner.organizationId,
    reuseMs: TOKEN_REUSE_MS,
  });
}

async function expectPlanState(
  page: Page,
  owner: BillingOwner,
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
        const token = await currentToken(page, owner);
        const state = await readBillingSummary(page, token);
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
  owner: BillingOwner,
  memberId: string,
  expected: UsagePackSummary,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const token = await currentToken(page, owner);
        return await readUsagePackSummary(page, token, memberId);
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `usage-pack state should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectUsagePackCreditState(
  page: Page,
  owner: BillingOwner,
  memberId: string,
  expected: UsagePackCreditSummary,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const token = await currentToken(page, owner);
        return await readUsagePackCreditSummary(page, token, memberId);
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `usage-pack credits should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectPendingInvitationState(
  page: Page,
  owner: BillingOwner,
  email: string,
  expected: PendingInvitationSummary | null,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const token = await currentToken(page, owner);
        return await readPendingInvitationSummary(page, token, email);
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `pending invitation should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectConcurrencyState(
  page: Page,
  owner: BillingOwner,
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
        const token = await currentToken(page, owner);
        const state = await readBillingSummary(page, token);
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

async function readUsagePackCreditSummary(
  page: Page,
  token: string,
  memberId: string,
): Promise<UsagePackCreditSummary> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/billing/usage-pack-credits", token),
    "usage-pack credits",
  );
  const member = requireArray(body.memberCredits, "member usage-pack credits")
    .map((value, index) => {
      return requireRecord(value, `member usage-pack credits ${index}`);
    })
    .find((value) => value.memberId === memberId);
  if (!member) {
    throw new Error(`usage-pack credits for member ${memberId} not found`);
  }
  return {
    bonusCredits: requireNumber(body.bonusCredits, "usage-pack bonus credits"),
    hasUsagePack: requireBoolean(body.hasUsagePack, "usage-pack availability"),
    memberTotalCredits: requireNumber(
      member.totalCredits,
      "member usage-pack total credits",
    ),
    purchasedCredits: requireNumber(
      body.purchasedCredits,
      "usage-pack purchased credits",
    ),
    totalCredits: requireNumber(body.totalCredits, "usage-pack total credits"),
  };
}

async function readPendingInvitationSummary(
  page: Page,
  token: string,
  email: string,
): Promise<PendingInvitationSummary | null> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/org/members", token),
    "organization members",
  );
  const invitation = requireArray(
    body.pendingInvitations,
    "pending invitations",
  )
    .map((value, index) => {
      return requireRecord(value, `pending invitation ${index}`);
    })
    .find((value) => value.email === email);
  if (!invitation) {
    return null;
  }
  return {
    email: requireString(invitation.email, "pending invitation email"),
    role: requireString(invitation.role, "pending invitation role"),
    usagePackUsd: requireNumber(
      invitation.usagePackUsd,
      "pending invitation usage pack",
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
