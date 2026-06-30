import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testBillingRedeemStateContract,
  type TestBillingRedeemStateActionBody,
} from "@vm0/api-contracts/contracts/test-billing-redeem-state";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgPromoRedemption } from "@vm0/db/schema/org-promo-redemption";
import { and, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testBillingRedeemStateContract.action);

type BillingRedeemAction<
  TAction extends TestBillingRedeemStateActionBody["action"],
> = Extract<TestBillingRedeemStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function seedOrgForAction(
  db: Db,
  body: BillingRedeemAction<"seed-org">,
  signal: AbortSignal,
) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await db.insert(orgMetadata).values({
    orgId,
    stripeCustomerId: body.stripe_customer_id ?? null,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      fixture: { org_id: orgId, user_id: userId },
    },
  };
}

async function deleteOrgForAction(
  db: Db,
  body: BillingRedeemAction<"delete-org">,
  signal: AbortSignal,
) {
  await db
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, body.fixture.org_id));
  signal.throwIfAborted();
  await db
    .delete(orgPromoRedemption)
    .where(eq(orgPromoRedemption.orgId, body.fixture.org_id));
  signal.throwIfAborted();
  await db
    .delete(orgMetadata)
    .where(eq(orgMetadata.orgId, body.fixture.org_id));
  signal.throwIfAborted();

  return actionOk();
}

async function seedOrgPromoRedemptionForAction(
  db: Db,
  body: BillingRedeemAction<"seed-org-promo-redemption">,
  signal: AbortSignal,
) {
  await db.insert(orgPromoRedemption).values({
    orgId: body.org_id,
    campaignKey: body.campaign_key,
    stripeSessionId: body.stripe_session_id,
  });
  signal.throwIfAborted();

  return actionOk();
}

async function readOrgPromoRedemptionForAction(
  db: Db,
  body: BillingRedeemAction<"read-org-promo-redemption">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({ stripeSessionId: orgPromoRedemption.stripeSessionId })
    .from(orgPromoRedemption)
    .where(
      and(
        eq(orgPromoRedemption.orgId, body.org_id),
        eq(orgPromoRedemption.campaignKey, body.campaign_key),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      promo_redemption: row
        ? { stripe_session_id: row.stripeSessionId }
        : undefined,
    },
  };
}

async function seedCreditExpiresRecordForAction(
  db: Db,
  body: BillingRedeemAction<"seed-credit-expires-record">,
  signal: AbortSignal,
) {
  await db.insert(creditExpiresRecord).values({
    orgId: body.org_id,
    source: body.source,
    stripeInvoiceId: body.stripe_invoice_id,
    amount: body.amount,
    remaining: body.amount,
    expiresAt: new Date(body.expires_at),
  });
  signal.throwIfAborted();

  return actionOk();
}

const mutateBillingRedeemState$ = command(
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
      case "seed-org": {
        return await seedOrgForAction(db, body, signal);
      }
      case "delete-org": {
        return await deleteOrgForAction(db, body, signal);
      }
      case "seed-org-promo-redemption": {
        return await seedOrgPromoRedemptionForAction(db, body, signal);
      }
      case "read-org-promo-redemption": {
        return await readOrgPromoRedemptionForAction(db, body, signal);
      }
      case "seed-credit-expires-record": {
        return await seedCreditExpiresRecordForAction(db, body, signal);
      }
    }
  },
);

export const testBillingRedeemStateRoutes: readonly RouteEntry[] = [
  {
    route: testBillingRedeemStateContract.action,
    handler: mutateBillingRedeemState$,
  },
];
