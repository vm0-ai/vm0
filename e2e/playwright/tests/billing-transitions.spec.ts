import type { Locator, Page, Request, Response } from "@playwright/test";
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
import {
  createMarkedAtomTeamGrant,
  findOrgLegacyPlanSubscription,
  readStripeSubscriptionStatus,
  reconcileBillingEntitlements,
} from "../lib/stripe-billing";
import { deriveAppUrl } from "../playwright.config";

type PaidTier = "pro" | "team";
type UsagePackUsd = 20 | 50 | 100 | 200;

interface BillingOwner {
  readonly organizationId: string;
  readonly session: BillingSession;
  readonly userId: string;
}

interface BillingOwnerSwitches {
  readonly realAgentInPreview?: boolean;
  readonly usagePackPlans: boolean;
}

interface BillingSession {
  refreshedAt: number;
  token: string;
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
  readonly credits: number;
  readonly hasSubscription: boolean;
  readonly payAsYouGoCredits: number;
  readonly scheduledChange: ScheduledPlanChangeSummary | null;
  readonly subscriptionStatus: string | null;
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

interface PendingInvitationSummary {
  readonly email: string;
  readonly role: string;
  readonly usagePackUsd: number | null;
}

interface UsagePackCreditSummary {
  readonly bonusCredits: number;
  readonly purchasedCredits: number;
  readonly purchasedGrantRemaining: number;
}

interface ChatSendSummary {
  readonly runId: string;
  readonly status: string | null;
  readonly threadId: string;
}

const apiUrl = process.env.VM0_API_BACKEND_URL!;
const appUrl = deriveAppUrl(apiUrl);
const appOrigin = new URL(appUrl).origin;
const STATE_TIMEOUT_MS = 60_000;
const TOKEN_REUSE_MS = 30_000;
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

test("legacy Plan purchases preserve Pro through a marked Atom override", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(
    page,
    "E2E Legacy Billing Purchases",
    async (owner) => {
      let token = await buyLegacyPlan(page, owner, "pro");
      await expectPlanIdentity(page, token, {
        hasSubscription: true,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const preservedPro = await findOrgLegacyPlanSubscription({
        orgId: owner.organizationId,
        tier: "pro",
      });
      expect(["active", "trialing"]).toContain(preservedPro.status);
      const atomGrant = await createMarkedAtomTeamGrant({
        orgId: owner.organizationId,
        subscription: preservedPro,
      });
      expect(atomGrant.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(atomGrant.id).toMatch(/^in_/u);

      await expectPlanIdentity(page, token, {
        hasSubscription: false,
        subscriptionStatus: "atom_grant",
        tier: "team",
      });
      await expect
        .poll(async () => await readStripeSubscriptionStatus(preservedPro.id), {
          intervals: POLL_INTERVALS_MS,
          message: "the purchased Pro subscription should remain active",
          timeout: STATE_TIMEOUT_MS,
        })
        .toMatch(/^(?:active|trialing)$/u);

      await expect
        .poll(
          async () => {
            if (Date.now() < atomGrant.expiresAt.getTime()) {
              return null;
            }
            await reconcileBillingEntitlements(apiUrl);
            token = await currentToken(page, owner);
            const state = await readBillingSummary(page, token);
            return {
              hasSubscription: state.hasSubscription,
              subscriptionStatus: state.subscriptionStatus,
              tier: state.tier,
            };
          },
          {
            intervals: [2_000, 3_000],
            message: "the expired Atom grant should restore purchased Pro",
            timeout: 90_000,
          },
        )
        .toEqual({
          hasSubscription: true,
          subscriptionStatus: "active",
          tier: "pro",
        });
      expect(await readStripeSubscriptionStatus(preservedPro.id)).toMatch(
        /^(?:active|trialing)$/u,
      );

      token = await upgradeLegacyProToTeamWithSavedCard(page, owner);
      await expectPlanIdentity(page, token, {
        hasSubscription: true,
        subscriptionStatus: "active",
        tier: "team",
      });
      const teamSubscription = await findOrgLegacyPlanSubscription({
        orgId: owner.organizationId,
        tier: "team",
      });
      expect(["active", "trialing"]).toContain(teamSubscription.status);

      token = await buyCreditsWithSavedCardAndReopen(page, owner);
      await expectPlanIdentity(page, token, {
        hasSubscription: true,
        subscriptionStatus: "active",
        tier: "team",
      });
    },
    { usagePackPlans: false },
  );
});

test("Team paid invitation and runner usage consume purchased credits first", async ({
  page,
}) => {
  test.setTimeout(360_000);

  await withBillingOwner(
    page,
    "E2E Team Purchase Consumption",
    async (owner) => {
      let token = await buyUsagePackPlan(page, owner, "team");
      await expectPlanState(page, token, {
        cancelAtPeriodEnd: false,
        hasSubscription: true,
        scheduledChange: null,
        tier: "team",
      });

      const inviteEmail = generateTestEmail("paid-onboarding");
      token = await purchasePaidInvitation(page, owner, inviteEmail, 20);
      await expectPendingInvitation(page, token, {
        email: inviteEmail,
        role: "member",
        usagePackUsd: 20,
      });

      const before = await waitForUsagePackCredits(page, token);
      expect(before.purchasedCredits).toBeGreaterThan(0);
      expect(before.purchasedGrantRemaining).toBeGreaterThan(0);
      await expectVm0ManagedModelPolicy(page, token, "gpt-5.6-sol");

      await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/agents\/.*\/chat/u, { timeout: 30_000 });
      await selectComposerModel(page, "GPT 5.6 Sol");
      const marker = `BILLING_USAGE_E2E_${Date.now()}`;
      const first = await sendComposerMessage(
        page,
        `Briefly reply with this exact marker: ${marker}`,
      );
      await expectRunStatus(page, token, first.runId, "completed");
      await expect(
        page
          .locator('[data-role="assistant"]')
          .filter({ hasText: marker })
          .first(),
      ).toBeVisible({ timeout: 90_000 });

      const settlement = await sendComposerMessage(
        page,
        "This follow-up run should be cancelled immediately.",
      );
      expect(settlement.threadId).toBe(first.threadId);
      expect(["pending", "queued"]).toContain(settlement.status);
      await cancelRun(page, token, settlement.runId);

      await expect
        .poll(
          async () => {
            return (await readUsagePackCreditSummary(page, token))
              .purchasedCredits;
          },
          {
            intervals: POLL_INTERVALS_MS,
            message: "runner usage should reduce purchased credits",
            timeout: STATE_TIMEOUT_MS,
          },
        )
        .toBeLessThan(before.purchasedCredits);
      const after = await readUsagePackCreditSummary(page, token);
      expect(after.bonusCredits).toBe(before.bonusCredits);
      expect(after.purchasedGrantRemaining).toBeLessThan(
        before.purchasedGrantRemaining,
      );
    },
    { realAgentInPreview: true, usagePackPlans: true },
  );
});

async function withBillingOwner(
  page: Page,
  organizationName: string,
  run: (owner: BillingOwner) => Promise<void>,
  switches: BillingOwnerSwitches = { usagePackPlans: true },
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
    });
    await completeExploreOnboarding(page, { appUrl });
    await configureBillingFeatureSwitches(page, token, switches);
    await run({
      organizationId,
      session: { refreshedAt: Date.now(), token },
      userId,
    });
  } finally {
    await deleteClerkTestOwnerResources(
      email,
      organizationId,
      "paid-onboarding",
    );
  }
}

async function configureBillingFeatureSwitches(
  page: Page,
  token: string,
  switches: BillingOwnerSwitches,
): Promise<void> {
  const response = await page.request.post(
    `${apiUrl}/api/okou/feature-switches`,
    {
      data: { switches },
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
  for (const [key, expected] of Object.entries(switches)) {
    if (effectiveSwitches[key] !== expected) {
      throw new Error(
        `${key} did not become ${String(expected)} for the billing E2E owner`,
      );
    }
  }
}

async function buyLegacyPlan(
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
  await expect(
    settings.getByText("Compare plans", { exact: true }).first(),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: `Start with ${planLabel}`, exact: true })
    .click();

  await fillStripeCheckout(page);
  await page.waitForURL((url) => url.origin === appOrigin, {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  return await currentToken(page, owner);
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
  return await currentToken(page, owner);
}

async function upgradeLegacyProToTeamWithSavedCard(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
  const usagePackRequests: string[] = [];
  const recordUsagePackRequest = (request: Request): void => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      path.startsWith("/api/okou/billing/usage-pack-subscription/")
    ) {
      usagePackRequests.push(path);
    }
  };
  page.on("request", recordUsagePackRequest);
  try {
    const settings = await openBillingSettings(page);
    await settings
      .getByRole("button", { name: "Upgrade", exact: true })
      .click();
    await expect(
      settings.getByText("Compare plans", { exact: true }).first(),
    ).toBeVisible();
    const previewResponsePromise = waitForPostResponse(
      page,
      "/api/okou/billing/checkout",
    );
    await settings
      .getByRole("button", { name: "Upgrade to Team", exact: true })
      .click();
    const preview = await responseRecord(
      await previewResponsePromise,
      "saved Plan preview",
    );
    expect(preview.status).toBe("preview");
    expect(preview.purchaseType).toBe("plan");
    expect(preview.tier).toBe("team");
    requireString(preview.previewToken, "saved Plan preview token");

    const dialog = page.getByRole("dialog", { name: "Upgrade to Team" });
    await expect(dialog).toBeVisible();
    const confirmResponsePromise = waitForPostResponse(
      page,
      "/api/okou/billing/checkout",
    );
    await dialog
      .getByRole("button", { name: "Upgrade to Team", exact: true })
      .click();
    const confirmation = await responseRecord(
      await confirmResponsePromise,
      "saved Plan confirmation",
    );
    expect(confirmation.status).toBe("completed");
    expect(confirmation.hostedInvoiceUrl).toBeNull();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(new URL(page.url()).origin).toBe(appOrigin);
    expect(usagePackRequests).toStrictEqual([]);
    return token;
  } finally {
    page.off("request", recordUsagePackRequest);
  }
}

async function buyCreditsWithSavedCardAndReopen(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
  const before = await readBillingSummary(page, token);
  const settings = await openBillingSettings(page);
  const locationOrigin = new URL(page.url()).origin;
  const previewResponsePromise = waitForPostResponse(
    page,
    "/api/okou/billing/credit-checkout",
  );
  await settings
    .getByRole("button", { name: "Quick buy $20.00", exact: true })
    .click();
  const preview = await responseRecord(
    await previewResponsePromise,
    "saved credit preview",
  );
  expect(preview.status).toBe("preview");
  const previewToken = requireString(
    preview.previewToken,
    "saved credit preview token",
  );
  const purchasedCredits = requireNumber(
    preview.credits,
    "saved credit preview credits",
  );
  const dialog = page.getByRole("dialog", {
    name: "Review credit purchase",
  });
  await expect(dialog).toBeVisible();
  const confirmResponsePromise = waitForPostResponse(
    page,
    "/api/okou/billing/credit-checkout/confirm",
  );
  await dialog
    .getByRole("button", { name: "Pay and add credits", exact: true })
    .click();
  const confirmation = await responseRecord(
    await confirmResponsePromise,
    "saved credit confirmation",
  );
  expect(confirmation.status).toBe("completed");
  expect(confirmation.hostedInvoiceUrl).toBeNull();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  expect(new URL(page.url()).origin).toBe(locationOrigin);

  await expect
    .poll(
      async () => {
        const state = await readBillingSummary(page, token);
        return {
          credits: state.credits,
          payAsYouGoCredits: state.payAsYouGoCredits,
        };
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: "saved credit purchase should update public balances",
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual({
      credits: before.credits + purchasedCredits,
      payAsYouGoCredits: before.payAsYouGoCredits + purchasedCredits,
    });

  const reopenedSettings = await openBillingSettings(page);
  const reopenedResponsePromise = waitForPostResponse(
    page,
    "/api/okou/billing/credit-checkout",
  );
  await reopenedSettings
    .getByRole("button", { name: "Quick buy $20.00", exact: true })
    .click();
  const reopenedPreview = await responseRecord(
    await reopenedResponsePromise,
    "reopened saved credit preview",
  );
  expect(reopenedPreview.status).toBe("preview");
  expect(
    requireString(
      reopenedPreview.previewToken,
      "reopened saved credit preview token",
    ),
  ).not.toBe(previewToken);
  const reopenedDialog = page.getByRole("dialog", {
    name: "Review credit purchase",
  });
  await expect(reopenedDialog).toBeVisible();
  await expect(
    reopenedDialog.getByText(
      "Could not complete this credit purchase. Review your billing details and try again.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    reopenedDialog.getByRole("button", {
      name: "Pay and add credits",
      exact: true,
    }),
  ).toBeEnabled();
  await reopenedDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(reopenedDialog).toBeHidden();
  return token;
}

async function purchasePaidInvitation(
  page: Page,
  owner: BillingOwner,
  email: string,
  usagePackUsd: UsagePackUsd,
): Promise<string> {
  const token = await currentToken(page, owner);
  await page.goto(new URL("/?settings=people", appUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByRole("heading", { name: "People" })).toBeVisible();
  await settings
    .getByRole("button", { name: "Add member", exact: true })
    .click();
  const invite = page.getByRole("dialog", { name: "Invite member" });
  await invite.getByPlaceholder("email@example.com").fill(email);
  const usagePack = invite.getByRole("combobox").nth(1);
  await usagePack.click();
  await page
    .getByRole("option", { name: USAGE_PACK_OPTION_PATTERNS[usagePackUsd] })
    .click();

  const previewResponsePromise = waitForPostResponse(
    page,
    "/api/okou/org/invite/purchase/preview",
  );
  await invite.getByRole("button", { name: "Continue", exact: true }).click();
  const preview = await responseRecord(
    await previewResponsePromise,
    "paid invitation preview",
  );
  const purchaseId = requireString(
    preview.purchaseId,
    "paid invitation purchase ID",
  );
  expect(preview.usagePackUsd).toBe(usagePackUsd);
  const confirmationDialog = page.getByRole("dialog", {
    name: "Review invitation",
  });
  await expect(confirmationDialog).toBeVisible();
  await expect(
    confirmationDialog.getByText(email, { exact: true }),
  ).toBeVisible();
  const confirmationResponsePromise = waitForPostResponse(
    page,
    `/api/okou/org/invite/purchase/${purchaseId}/confirm`,
  );
  await confirmationDialog
    .getByRole("button", { name: "Pay and invite", exact: true })
    .click();
  const confirmation = await responseRecord(
    await confirmationResponsePromise,
    "paid invitation confirmation",
  );
  requireString(confirmation.message, "paid invitation confirmation message");
  await expect(confirmationDialog).toBeHidden({ timeout: 30_000 });
  expect(new URL(page.url()).origin).toBe(appOrigin);
  return token;
}

async function changeUsagePack(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
  target: UsagePackUsd,
  action: "Confirm" | "Restore",
  backFromReviewOnce = false,
): Promise<string> {
  const token = await currentToken(page, owner);
  const packages = await openUsagePackManagement(page, tier);
  await selectUsagePack(page, packages, target);
  return await submitUsagePackConfiguration(
    page,
    packages,
    action,
    token,
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
  packages: Locator,
  action: "Confirm" | "Restore",
  token: string,
  backFromReviewOnce = false,
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
  if (backFromReviewOnce) {
    await review.getByRole("button", { name: "Back", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(actionButton).toBeEnabled();
    await actionButton.click();
    review = page.getByRole("dialog", { name: "Review package change" });
    await expect(review).toBeVisible();
  }

  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  return token;
}

async function cancelPlan(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return token;
}

async function restorePlan(
  page: Page,
  owner: BillingOwner,
  tier: PaidTier,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return token;
}

async function upgradeProToTeam(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
  const settings = await openBillingSettings(page);
  await settings.getByRole("button", { name: "Upgrade", exact: true }).click();
  const packages = page.getByRole("dialog", {
    name: "Configure member packages",
  });
  await expect(packages).toBeVisible();
  return await submitUsagePackConfiguration(page, packages, "Confirm", token);
}

async function downgradeTeamToPro(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return await submitUsagePackConfiguration(page, packages, "Confirm", token);
}

async function replaceTeamCancellationWithPro(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return token;
}

async function buyConcurrency(
  page: Page,
  owner: BillingOwner,
  quantity: number,
): Promise<string> {
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
  return token;
}

async function changeConcurrency(
  page: Page,
  owner: BillingOwner,
  targetQuantity: number,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return token;
}

async function cancelConcurrency(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
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
  return token;
}

async function restoreConcurrency(
  page: Page,
  owner: BillingOwner,
): Promise<string> {
  const token = await currentToken(page, owner);
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

async function currentToken(page: Page, owner: BillingOwner): Promise<string> {
  if (Date.now() - owner.session.refreshedAt < TOKEN_REUSE_MS) {
    return owner.session.token;
  }
  const token = await refreshClerkSessionToken(page, {
    activeOrganizationId: owner.organizationId,
  });
  owner.session.refreshedAt = Date.now();
  owner.session.token = token;
  return token;
}

async function expectPlanIdentity(
  page: Page,
  token: string,
  expected: {
    readonly hasSubscription: boolean;
    readonly subscriptionStatus: string;
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
          hasSubscription: state.hasSubscription,
          subscriptionStatus: state.subscriptionStatus,
          tier: state.tier,
        };
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `billing identity should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function expectPendingInvitation(
  page: Page,
  token: string,
  expected: PendingInvitationSummary,
): Promise<void> {
  await expect
    .poll(
      async () => {
        return await pollSafely(async () => {
          const invitations = await readPendingInvitations(page, token);
          return (
            invitations.find((invitation) => {
              return invitation.email === expected.email;
            }) ?? null
          );
        });
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `pending invitation should become ${JSON.stringify(expected)}`,
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toEqual(expected);
}

async function waitForUsagePackCredits(
  page: Page,
  token: string,
): Promise<UsagePackCreditSummary> {
  await expect
    .poll(
      async () => {
        return (await readUsagePackCreditSummary(page, token)).purchasedCredits;
      },
      {
        intervals: POLL_INTERVALS_MS,
        message:
          "the owner usage-pack allocation should have purchased credits",
        timeout: STATE_TIMEOUT_MS,
      },
    )
    .toBeGreaterThan(0);
  return await readUsagePackCreditSummary(page, token);
}

async function expectVm0ManagedModelPolicy(
  page: Page,
  token: string,
  model: string,
): Promise<void> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/model-policies", token),
    "model policies",
  );
  const policy = requireArray(body.policies, "model policies")
    .map((value, index) => {
      return requireRecord(value, `model policy ${index}`);
    })
    .find((value) => value.model === model);
  if (!policy) {
    throw new Error(`Model policy ${model} was not found`);
  }
  expect(policy.defaultProviderType).toBe("vm0");
  expect(policy.credentialScope).toBe("org");
  expect(policy.modelProviderId).toBeNull();
}

async function selectComposerModel(page: Page, label: string): Promise<void> {
  const composer = page.locator(".zero-composer");
  const picker = composer.getByRole("combobox").first();
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(
    composer.getByRole("combobox", { name: label, exact: true }),
  ).toBeVisible();
}

async function sendComposerMessage(
  page: Page,
  message: string,
): Promise<ChatSendSummary> {
  const composer = page.locator(".zero-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(message);
  const responsePromise = waitForPostResponse(page, "/api/okou/chat/events");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  const body = await responseRecord(
    await responsePromise,
    "chat send response",
  );
  return {
    runId: requireString(body.runId, "chat send run ID"),
    status:
      body.status === undefined
        ? null
        : requireString(body.status, "chat send status"),
    threadId: requireString(body.threadId, "chat send thread ID"),
  };
}

async function expectRunStatus(
  page: Page,
  token: string,
  runId: string,
  expectedStatus: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const body = requireRecord(
          await getApiJson(page, `/api/okou/runs/${runId}`, token),
          "run status",
        );
        return requireString(body.status, "run status value");
      },
      {
        intervals: POLL_INTERVALS_MS,
        message: `run ${runId} should become ${expectedStatus}`,
        timeout: 180_000,
      },
    )
    .toBe(expectedStatus);
}

async function cancelRun(
  page: Page,
  token: string,
  runId: string,
): Promise<void> {
  const response = await page.request.post(
    new URL(`/api/okou/runs/${runId}/cancel`, apiUrl).toString(),
    { headers: authHeadersForToken(token) },
  );
  if (response.status() !== 200) {
    throw new Error(
      `run cancellation failed with ${response.status()}: ${await response.text()}`,
    );
  }
  const body = requireRecord(await response.json(), "run cancellation");
  expect(body.id).toBe(runId);
  expect(body.status).toBe("cancelled");
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
  const payAsYouGoCredits = requireArray(
    body.creditBreakdown,
    "billing credit breakdown",
  )
    .map((value, index) => {
      return requireRecord(value, `billing credit breakdown ${index}`);
    })
    .filter((segment) => segment.category === "payAsYouGo")
    .reduce((total, segment) => {
      return (
        total + requireNumber(segment.credits, "pay-as-you-go credit breakdown")
      );
    }, 0);

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
    credits: requireNumber(body.credits, "billing credits"),
    hasSubscription: requireBoolean(
      body.hasSubscription,
      "billing hasSubscription",
    ),
    payAsYouGoCredits,
    scheduledChange,
    subscriptionStatus: optionalNullableString(
      body.subscriptionStatus,
      "billing subscriptionStatus",
    ),
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

async function readPendingInvitations(
  page: Page,
  token: string,
): Promise<readonly PendingInvitationSummary[]> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/org/members", token),
    "organization members",
  );
  if (body.pendingInvitations === undefined) {
    return [];
  }
  return requireArray(
    body.pendingInvitations,
    "pending organization invitations",
  ).map((value, index) => {
    const invitation = requireRecord(value, `pending invitation ${index}`);
    return {
      email: requireString(invitation.email, "pending invitation email"),
      role: requireString(invitation.role, "pending invitation role"),
      usagePackUsd: optionalNullableNumber(
        invitation.usagePackUsd,
        "pending invitation usage pack",
      ),
    };
  });
}

async function readUsagePackCreditSummary(
  page: Page,
  token: string,
): Promise<UsagePackCreditSummary> {
  const body = requireRecord(
    await getApiJson(page, "/api/okou/billing/usage-pack-credits", token),
    "usage-pack credits",
  );
  const purchasedGrantRemaining = requireArray(
    body.creditGrants,
    "usage-pack credit grants",
  )
    .map((value, index) => {
      return requireRecord(value, `usage-pack credit grant ${index}`);
    })
    .filter((grant) => grant.grantType === "purchased")
    .reduce((total, grant) => {
      return (
        total +
        requireNumber(grant.remaining, "purchased credit grant remaining")
      );
    }, 0);
  return {
    bonusCredits: requireNumber(body.bonusCredits, "usage-pack bonus credits"),
    purchasedCredits: requireNumber(
      body.purchasedCredits,
      "usage-pack purchased credits",
    ),
    purchasedGrantRemaining,
  };
}

function waitForPostResponse(page: Page, path: string): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      if (response.request().method() !== "POST") {
        return false;
      }
      const responsePath = new URL(response.url()).pathname;
      return responsePath === path;
    },
    { timeout: STATE_TIMEOUT_MS },
  );
}

async function responseRecord(
  response: Response,
  description: string,
): Promise<Record<string, unknown>> {
  if (!response.ok()) {
    throw new Error(
      `${description} failed with ${response.status()}: ${await response.text()}`,
    );
  }
  const body: unknown = await response.json();
  return requireRecord(body, description);
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
