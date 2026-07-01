import { command } from "ccstate";
import {
  testWebhooksStateContract,
  type TestWebhooksStateActionBody,
} from "@vm0/api-contracts/contracts/test-webhooks-state";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgConcurrencyEntitlements } from "@vm0/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import { setFirewallAuthRefreshTimeoutMsForTests } from "../services/agent-webhook-firewall-auth.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testWebhooksStateContract.action);

type WebhooksAction<TAction extends TestWebhooksStateActionBody["action"]> =
  Extract<TestWebhooksStateActionBody, { action: TAction }>;

const restoreFirewallAuthRefreshTimeout = testOverride<(() => void) | null>(
  () => {
    return null;
  },
);

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function dateToWire(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function expireAtomGrantsForAction(
  db: Db,
  body: WebhooksAction<"expire-atom-grants">,
  signal: AbortSignal,
) {
  const expiredAt = new Date(body.expired_at);
  await db
    .update(orgMetadata)
    .set({ currentPeriodEnd: expiredAt, updatedAt: expiredAt })
    .where(eq(orgMetadata.orgId, body.org_id));
  signal.throwIfAborted();
  await db
    .update(creditExpiresRecord)
    .set({ expiresAt: expiredAt })
    .where(eq(creditExpiresRecord.orgId, body.org_id));
  signal.throwIfAborted();
  return actionOk();
}

async function readOrgCleanupForAction(
  db: Db,
  body: WebhooksAction<"read-org-cleanup">,
  signal: AbortSignal,
) {
  const [cache, metadata, members] = await Promise.all([
    db
      .select({ org_id: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, body.org_id)),
    db
      .select({
        stripe_customer_id: orgMetadata.stripeCustomerId,
        stripe_subscription_id: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, body.org_id)),
    db
      .select({ user_id: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.orgId, body.org_id)),
  ]);
  signal.throwIfAborted();
  return actionOk({ org_cleanup: { cache, metadata, members } });
}

async function seedOrgMemberForAction(
  db: Db,
  body: WebhooksAction<"seed-org-member">,
  signal: AbortSignal,
) {
  await db
    .insert(orgMembersCache)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      role: body.role,
      cachedAt: new Date(body.cached_at),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: body.role, cachedAt: new Date(body.cached_at) },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function readBillingStateForAction(
  db: Db,
  body: WebhooksAction<"read-billing-state">,
  signal: AbortSignal,
) {
  const [org] = await db
    .select({ stripeSubscriptionId: orgMetadata.stripeSubscriptionId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, body.org_id))
    .limit(1);
  signal.throwIfAborted();

  const entitlements = await db
    .select({
      stripe_invoice_line_id: orgConcurrencyEntitlements.stripeInvoiceLineId,
      stripe_subscription_id: orgConcurrencyEntitlements.stripeSubscriptionId,
      slots: orgConcurrencyEntitlements.slots,
      starts_at: orgConcurrencyEntitlements.startsAt,
      expires_at: orgConcurrencyEntitlements.expiresAt,
    })
    .from(orgConcurrencyEntitlements)
    .where(eq(orgConcurrencyEntitlements.orgId, body.org_id));
  signal.throwIfAborted();

  const subscriptionWhere = body.stripe_subscription_id
    ? eq(
        orgConcurrencySubscriptions.stripeSubscriptionId,
        body.stripe_subscription_id,
      )
    : eq(orgConcurrencySubscriptions.orgId, body.org_id);
  const subscriptions = await db
    .select({
      stripe_subscription_id: orgConcurrencySubscriptions.stripeSubscriptionId,
      slots: orgConcurrencySubscriptions.slots,
      subscription_status: orgConcurrencySubscriptions.subscriptionStatus,
      current_period_end: orgConcurrencySubscriptions.currentPeriodEnd,
      cancel_at_period_end: orgConcurrencySubscriptions.cancelAtPeriodEnd,
    })
    .from(orgConcurrencySubscriptions)
    .where(subscriptionWhere);
  signal.throwIfAborted();

  return actionOk({
    billing_state: {
      stripe_subscription_id: org?.stripeSubscriptionId ?? null,
      concurrency_entitlements: entitlements.map((row) => {
        return {
          ...row,
          starts_at: dateToWire(row.starts_at) ?? "",
          expires_at: dateToWire(row.expires_at) ?? "",
        };
      }),
      concurrency_subscriptions: subscriptions.map((row) => {
        return {
          ...row,
          current_period_end: dateToWire(row.current_period_end),
        };
      }),
    },
  });
}

const mutateWebhooksState$ = command(
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
      case "expire-atom-grants": {
        return await expireAtomGrantsForAction(db, body, signal);
      }
      case "read-org-cleanup": {
        return await readOrgCleanupForAction(db, body, signal);
      }
      case "seed-org-member": {
        return await seedOrgMemberForAction(db, body, signal);
      }
      case "read-billing-state": {
        return await readBillingStateForAction(db, body, signal);
      }
      case "set-firewall-auth-refresh-timeout-ms": {
        restoreFirewallAuthRefreshTimeout.get()?.();
        restoreFirewallAuthRefreshTimeout.set(
          setFirewallAuthRefreshTimeoutMsForTests(body.timeout_ms),
        );
        return actionOk();
      }
      case "reset-firewall-auth-refresh-timeout-ms": {
        restoreFirewallAuthRefreshTimeout.get()?.();
        restoreFirewallAuthRefreshTimeout.clear();
        return actionOk();
      }
    }
  },
);

export const testWebhooksStateRoutes: readonly RouteEntry[] = [
  {
    route: testWebhooksStateContract.action,
    handler: mutateWebhooksState$,
  },
];
