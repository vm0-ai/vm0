/**
 * Narrow in-process fixtures for usage allowance state that has no equivalent
 * product-facing setup or read surface.
 *
 * Entitlements are created through Stripe webhooks. Explicit window seeds are
 * reserved for read scenarios that need pre-existing or historical state.
 */
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@vm0/db/schema/org-usage-allowance";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

interface UsageAllowanceEntitlementFixtureState {
  readonly orgId: string;
  readonly status: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeInvoiceId: string | null;
}

interface UsageAllowanceWindowFixtureSeed {
  readonly kind: "short" | "weekly";
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly unitLimit: number;
  readonly consumedUnits?: number;
}

export async function insertUsageAllowanceWindowsFixture(values: {
  readonly orgId: string;
  readonly windows: readonly UsageAllowanceWindowFixtureSeed[];
}): Promise<void> {
  if (values.windows.length === 0) {
    return;
  }

  const db = createStore().set(writeDb$);
  const [entitlement] = await db
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, values.orgId))
    .limit(1);

  if (!entitlement) {
    throw new Error(
      `insertUsageAllowanceWindowsFixture: missing entitlement for ${values.orgId}`,
    );
  }

  await db.insert(orgUsageAllowanceWindows).values(
    values.windows.map((window) => {
      return {
        orgId: values.orgId,
        entitlementId: entitlement.id,
        kind: window.kind,
        startsAt: window.startsAt,
        expiresAt: window.expiresAt,
        unitLimit: window.unitLimit,
        consumedUnits: window.consumedUnits ?? 0,
      };
    }),
  );
}

export async function readUsageAllowanceEntitlementFixture(
  orgId: string,
): Promise<UsageAllowanceEntitlementFixtureState | null> {
  const [row] = await createStore()
    .set(writeDb$)
    .select({
      orgId: orgUsageAllowanceEntitlements.orgId,
      status: orgUsageAllowanceEntitlements.status,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      stripeCustomerId: orgUsageAllowanceEntitlements.stripeCustomerId,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      stripeInvoiceId: orgUsageAllowanceEntitlements.stripeInvoiceId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    ...row,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}
