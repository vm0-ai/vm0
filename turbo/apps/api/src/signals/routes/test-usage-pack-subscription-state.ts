import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usagePackCreditGrants } from "@vm0/db/schema/usage-pack-credit-grant";
import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptions,
} from "@vm0/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const usagePackUsdSchema = z.union([
  z.literal(20),
  z.literal(50),
  z.literal(100),
  z.literal(200),
]);
type UsagePackUsd = z.infer<typeof usagePackUsdSchema>;

const seedAllocationSchema = z
  .object({
    userId: z.string().min(1).nullable(),
    invitationId: z.string().min(1).nullable(),
    usagePackUsd: usagePackUsdSchema,
    stripePriceId: z.string().min(1),
  })
  .refine((allocation) => {
    return (allocation.userId === null) !== (allocation.invitationId === null);
  });

const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed"),
    orgId: z.string().min(1),
    tier: z.enum(["pro", "team"]),
    stripePlanPriceId: z.string().min(1),
    stripeCustomerId: z.string().min(1),
    stripeCheckoutSessionId: z.string().min(1),
    allocations: z.array(seedAllocationSchema).min(1),
  }),
  z.object({
    action: z.literal("read"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid().optional(),
  }),
  z.object({
    action: z.literal("set-updated-at"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    updatedAt: z.iso.datetime(),
  }),
  z.object({
    action: z.literal("cleanup"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    deleteGrants: z.boolean(),
    deleteOrgMetadata: z.boolean(),
  }),
]);

const nullableDateSchema = z.iso.datetime().nullable();
const readStateSchema = z.object({
  subscriptionCount: z.number().int().nonnegative(),
  subscription: z
    .object({
      id: z.string().uuid(),
      stripeCheckoutSessionId: z.string().nullable(),
      stripeSubscriptionId: z.string().nullable(),
      subscriptionStatus: z.string(),
      currentPeriodStart: nullableDateSchema,
      currentPeriodEnd: nullableDateSchema,
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  allocations: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().nullable(),
      invitationId: z.string().nullable(),
      usagePackUsd: usagePackUsdSchema,
      stripePriceId: z.string(),
      status: z.string(),
      currentPeriodStart: nullableDateSchema,
      currentPeriodEnd: nullableDateSchema,
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string(),
      kind: z.enum(["upgrade", "downgrade", "removal"]),
      status: z.enum([
        "previewed",
        "applying",
        "pending_payment",
        "scheduled",
        "applied",
        "completed",
        "failed",
      ]),
      sourceUsagePackUsd: usagePackUsdSchema,
      targetUsagePackUsd: usagePackUsdSchema.nullable(),
      immediateAmountCents: z.number().int().nonnegative().nullable(),
      nextRecurringAmountCents: z.number().int().nonnegative().nullable(),
      effectiveAt: nullableDateSchema,
      stripeInvoiceId: z.string().nullable(),
    }),
  ),
  grants: z.array(
    z.object({
      userId: z.string(),
      grantType: z.enum(["purchased", "bonus"]),
      originalAmount: z.number().int().positive(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  fulfillmentInvoiceIds: z.array(z.string()),
  remainingCredits: z.array(
    z.object({
      userId: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  ),
  org: z
    .object({
      tier: z.string(),
      credits: z.number().int(),
      stripeSubscriptionId: z.string().nullable(),
      subscriptionStatus: z.string().nullable(),
      currentPeriodEnd: nullableDateSchema,
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
});

const actionResponseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seeded"),
    usagePackSubscriptionId: z.string().uuid(),
  }),
  z.object({ action: z.literal("read"), state: readStateSchema }),
  z.object({ action: z.literal("ok") }),
]);

const c = initContract();
export const testUsagePackSubscriptionStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-pack-subscription-state/action",
    body: actionBodySchema,
    responses: {
      200: actionResponseSchema,
      400: z.object({
        error: z.object({ code: z.string(), message: z.string() }),
      }),
      404: z.string(),
    },
  },
});

export type TestUsagePackSubscriptionStateAction = z.infer<
  typeof actionBodySchema
>;
export type TestUsagePackSubscriptionStateResponse = z.infer<
  typeof actionResponseSchema
>;

type SeedAction = Extract<
  TestUsagePackSubscriptionStateAction,
  { readonly action: "seed" }
>;

// Stripe callbacks and cron are production ingress surfaces, but production
// deliberately has no API for constructing a pending local correlation row or
// reading its per-member fulfillment ledger. This narrowly scoped, test-only
// boundary exposes only the state required to verify those external lifecycles.
async function seedUsagePackState(
  db: Db,
  body: SeedAction,
  signal: AbortSignal,
): Promise<string> {
  return await db.transaction(async (tx) => {
    const orgRows = await tx
      .update(orgMetadata)
      .set({ stripeCustomerId: body.stripeCustomerId })
      .where(eq(orgMetadata.orgId, body.orgId))
      .returning({ orgId: orgMetadata.orgId });
    if (orgRows.length !== 1) {
      throw new Error(`Missing organization fixture ${body.orgId}`);
    }
    const [subscription] = await tx
      .insert(usagePackSubscriptions)
      .values({
        orgId: body.orgId,
        tier: body.tier,
        stripePlanPriceId: body.stripePlanPriceId,
        stripeCustomerId: body.stripeCustomerId,
        stripeCheckoutSessionId: body.stripeCheckoutSessionId,
      })
      .returning({ id: usagePackSubscriptions.id });
    if (!subscription) {
      throw new Error("Failed to seed usage pack subscription state");
    }
    await tx.insert(usagePackAllocations).values(
      body.allocations.map((allocation) => {
        return {
          usagePackSubscriptionId: subscription.id,
          orgId: body.orgId,
          ...allocation,
        };
      }),
    );
    signal.throwIfAborted();
    return subscription.id;
  });
}

function isoDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

interface UsagePackRelatedStateRows {
  readonly allocations: (typeof usagePackAllocations.$inferSelect)[];
  readonly fulfillments: { readonly invoiceId: string }[];
  readonly changes: (typeof usagePackAllocationChanges.$inferSelect)[];
}

async function readUsagePackRelatedStateRows(
  db: Db,
  usagePackSubscriptionId: string | undefined,
): Promise<UsagePackRelatedStateRows> {
  if (!usagePackSubscriptionId) {
    return { allocations: [], fulfillments: [], changes: [] };
  }
  const [allocations, fulfillments, changes] = await Promise.all([
    db
      .select()
      .from(usagePackAllocations)
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      )
      .orderBy(asc(usagePackAllocations.id)),
    db
      .select({ invoiceId: usagePackInvoiceFulfillments.stripeInvoiceId })
      .from(usagePackInvoiceFulfillments)
      .where(
        eq(
          usagePackInvoiceFulfillments.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      )
      .orderBy(asc(usagePackInvoiceFulfillments.stripeInvoiceId)),
    db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        eq(
          usagePackAllocationChanges.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      )
      .orderBy(asc(usagePackAllocationChanges.createdAt)),
  ]);
  return { allocations, fulfillments, changes };
}

async function readUsagePackState(
  db: Db,
  orgId: string,
  usagePackSubscriptionId: string | undefined,
  signal: AbortSignal,
) {
  const [countRow] = await db
    .select({ value: count() })
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.orgId, orgId));
  if (!countRow) {
    throw new Error("Failed to count usage pack subscriptions");
  }
  const subscriptionCount = countRow.value;
  const [subscription] = usagePackSubscriptionId
    ? await db
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, orgId),
          ),
        )
        .limit(1)
    : [];
  const { allocations, fulfillments, changes } =
    await readUsagePackRelatedStateRows(db, subscription?.id);
  const grants = await db
    .select()
    .from(usagePackCreditGrants)
    .where(eq(usagePackCreditGrants.orgId, orgId))
    .orderBy(
      asc(usagePackCreditGrants.expiresAt),
      asc(usagePackCreditGrants.grantType),
    );
  const [org] = await db
    .select()
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  signal.throwIfAborted();
  const remainingCreditsByUser = new Map<string, number>();
  for (const grant of grants) {
    remainingCreditsByUser.set(
      grant.userId,
      (remainingCreditsByUser.get(grant.userId) ?? 0) + grant.remainingAmount,
    );
  }

  return {
    subscriptionCount,
    subscription: subscription
      ? {
          id: subscription.id,
          stripeCheckoutSessionId: subscription.stripeCheckoutSessionId,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          subscriptionStatus: subscription.subscriptionStatus,
          currentPeriodStart: isoDate(subscription.currentPeriodStart),
          currentPeriodEnd: isoDate(subscription.currentPeriodEnd),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    allocations: allocations.map((allocation) => {
      return {
        id: allocation.id,
        userId: allocation.userId,
        invitationId: allocation.invitationId,
        usagePackUsd: allocation.usagePackUsd as 20 | 50 | 100 | 200,
        stripePriceId: allocation.stripePriceId,
        status: allocation.status,
        currentPeriodStart: isoDate(allocation.currentPeriodStart),
        currentPeriodEnd: isoDate(allocation.currentPeriodEnd),
      };
    }),
    changes: changes.map((change) => {
      return {
        id: change.id,
        userId: change.userId,
        kind: change.kind,
        status: change.status,
        sourceUsagePackUsd: change.sourceUsagePackUsd as UsagePackUsd,
        targetUsagePackUsd: change.targetUsagePackUsd as UsagePackUsd | null,
        immediateAmountCents: change.immediateAmountCents,
        nextRecurringAmountCents: change.nextRecurringAmountCents,
        effectiveAt: isoDate(change.effectiveAt),
        stripeInvoiceId: change.stripeInvoiceId,
      };
    }),
    grants: grants.map((grant) => {
      return {
        userId: grant.userId,
        grantType: grant.grantType,
        originalAmount: grant.originalAmount,
        expiresAt: grant.expiresAt.toISOString(),
      };
    }),
    fulfillmentInvoiceIds: fulfillments.map((row) => {
      return row.invoiceId;
    }),
    remainingCredits: [...remainingCreditsByUser].map(([userId, amount]) => {
      return { userId, amount };
    }),
    org: org
      ? {
          tier: org.tier,
          credits: org.credits,
          stripeSubscriptionId: org.stripeSubscriptionId,
          subscriptionStatus: org.subscriptionStatus,
          currentPeriodEnd: isoDate(org.currentPeriodEnd),
          cancelAtPeriodEnd: org.cancelAtPeriodEnd,
        }
      : null,
  };
}

async function cleanupUsagePackState(
  db: Db,
  body: Extract<
    TestUsagePackSubscriptionStateAction,
    { readonly action: "cleanup" }
  >,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (body.deleteGrants) {
      await tx
        .delete(usagePackCreditGrants)
        .where(eq(usagePackCreditGrants.orgId, body.orgId));
    }
    await tx
      .delete(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, body.orgId),
        ),
      );
    if (body.deleteOrgMetadata) {
      await tx.delete(orgMetadata).where(eq(orgMetadata.orgId, body.orgId));
    }
    signal.throwIfAborted();
  });
}

const actionBody$ = bodyResultOf(testUsagePackSubscriptionStateContract.action);

const mutateTestUsagePackSubscriptionState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "seed": {
        const usagePackSubscriptionId = await seedUsagePackState(
          db,
          body,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "seeded" as const, usagePackSubscriptionId },
        };
      }
      case "read": {
        const state = await readUsagePackState(
          db,
          body.orgId,
          body.usagePackSubscriptionId,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "read" as const, state },
        };
      }
      case "set-updated-at": {
        await db
          .update(usagePackSubscriptions)
          .set({ updatedAt: new Date(body.updatedAt) })
          .where(
            and(
              eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
              eq(usagePackSubscriptions.orgId, body.orgId),
            ),
          );
        signal.throwIfAborted();
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "cleanup": {
        await cleanupUsagePackState(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
    }
  },
);

export const testUsagePackSubscriptionStateRoutes: readonly RouteEntry[] = [
  {
    route: testUsagePackSubscriptionStateContract.action,
    handler: mutateTestUsagePackSubscriptionState$,
  },
];
