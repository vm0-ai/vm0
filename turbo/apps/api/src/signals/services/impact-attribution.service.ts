import { IMPACT_PRIVACY_RECEIPT_KEY } from "@okouai/api-contracts/contracts/marketing-privacy";
import { command } from "ccstate";
import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import {
  IMPACT_ATTRIBUTION_METADATA_KEY,
  parseImpactAttribution,
  type ImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";

import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { optionalEnv } from "../../lib/env";
import { authContext$ } from "../auth/auth-context";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const log = logger("impact-attribution");

const persistOrgImpactAttribution$ = command(
  async (
    { get, set },
    orgId: string,
    attribution: ImpactAttribution,
    signal: AbortSignal,
  ): Promise<void> => {
    const auth = get(authContext$);
    if (auth.orgId !== orgId || auth.orgRole !== "admin") {
      return;
    }
    const capturedAt = new Date(attribution.capturedAt);
    await set(writeDb$)
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId,
        impactClickId: attribution.clickId,
        impactClickAt: capturedAt,
      })
      .onConflictDoUpdate({
        target: orgMetadataCanonicalWrites.orgId,
        set: {
          impactClickId: attribution.clickId,
          impactClickAt: capturedAt,
          updatedAt: nowDate(),
        },
        setWhere: or(
          isNull(orgMetadata.impactClickAt),
          lt(orgMetadata.impactClickAt, capturedAt),
        ),
      });
    signal.throwIfAborted();
  },
);

export async function readOrgImpactMetadata(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({
      clickId: orgMetadata.impactClickId,
      capturedAt: orgMetadata.impactClickAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  signal.throwIfAborted();
  return row?.clickId && row.capturedAt
    ? {
        impact_click_id: row.clickId,
        impact_click_at: row.capturedAt.toISOString(),
      }
    : {};
}

// Customer creation is called by authenticated billing routes. Bind the click
// to the actual purchaser; never select an arbitrary member of their org.
export const impactStripeMetadata$ = command(
  async (
    { get, set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<Record<string, string>> => {
    const auth = get(authContext$);
    if (auth.orgId !== orgId || auth.orgRole !== "admin") {
      return {};
    }
    const result = await settle(
      get(clerk$).users.getUserList(
        { userId: [auth.userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      // Attribution enrichment is best effort; payment availability takes priority.
      log.warn("Unable to resolve purchaser Impact attribution", {
        userId: auth.userId,
      });
      return readOrgImpactMetadata(set(writeDb$), orgId, signal);
    }
    const user = result.value.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    const impact = parseImpactAttribution(
      user?.privateMetadata?.[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (impact) {
      await set(persistOrgImpactAttribution$, orgId, impact, signal);
    }
    const metadata = await readOrgImpactMetadata(set(writeDb$), orgId, signal);
    const receipt = user?.privateMetadata?.[IMPACT_PRIVACY_RECEIPT_KEY];
    return {
      ...metadata,
      ...(impact &&
      metadata.impact_click_id === impact.clickId &&
      metadata.impact_click_at === impact.capturedAt &&
      typeof receipt === "string"
        ? {
            impact_privacy_receipt: receipt,
            impact_privacy_user_id: auth.userId,
          }
        : {}),
    };
  },
);

function shouldUpdateImpactMetadata(
  previous: Readonly<Record<string, string>>,
  next: {
    readonly impact_click_id: string;
    readonly impact_click_at: string;
    readonly impact_privacy_receipt: string;
    readonly impact_privacy_user_id: string;
  },
): boolean {
  if (
    !previous.impact_click_at ||
    previous.impact_click_at < next.impact_click_at
  ) {
    return true;
  }
  return (
    previous.impact_click_at === next.impact_click_at &&
    previous.impact_click_id === next.impact_click_id &&
    ((previous.impact_privacy_receipt ?? "") !== next.impact_privacy_receipt ||
      (previous.impact_privacy_user_id ?? "") !== next.impact_privacy_user_id)
  );
}

export async function updateImpactCustomer(
  customerId: string,
  metadata: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<void> {
  const capturedAt = metadata.impact_click_at;
  if (!metadata.impact_click_id || !capturedAt) {
    return;
  }
  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId);
  signal.throwIfAborted();
  if (
    customer.deleted ||
    (customer.metadata.impact_click_at &&
      (customer.metadata.impact_click_at > capturedAt ||
        (customer.metadata.impact_click_at === capturedAt &&
          customer.metadata.impact_click_id !== metadata.impact_click_id)))
  ) {
    return;
  }
  // Stripe merges metadata updates. Clear absent proof on every caller path so
  // a click cannot inherit the previous purchaser's receipt. Proof can also
  // change without a newer click when the current purchaser has no receipt.
  const nextMetadata = {
    ...metadata,
    impact_click_id: metadata.impact_click_id,
    impact_click_at: capturedAt,
    impact_privacy_receipt: metadata.impact_privacy_receipt ?? "",
    impact_privacy_user_id: metadata.impact_privacy_user_id ?? "",
  };
  if (shouldUpdateImpactMetadata(customer.metadata, nextMetadata)) {
    await stripe.customers.update(customerId, { metadata: nextMetadata });
    signal.throwIfAborted();
  }
  // Stripe copies subscription metadata onto each newly created invoice.
  // Refresh future renewals while existing invoices retain their own snapshot.
  const subscriptions = await listAllStripeSubscriptions(
    stripe,
    { customer: customerId, status: "all" },
    signal,
  );
  for (const subscription of subscriptions) {
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      continue;
    }
    if (
      !shouldUpdateImpactMetadata(subscription.metadata ?? {}, nextMetadata)
    ) {
      continue;
    }
    await stripe.subscriptions.update(subscription.id, {
      metadata: nextMetadata,
    });
    signal.throwIfAborted();
  }
}

// A returning subscriber can upgrade without creating another customer.
// Refresh an existing customer's click at login as well as at checkout.
export const syncImpactStripeCustomer$ = command(
  async (
    { get, set },
    metadata: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<void> => {
    const auth = get(authContext$);
    if (!auth.orgId || auth.orgRole !== "admin") {
      return;
    }
    const orgId = auth.orgId;
    const impact = parseImpactAttribution(
      {
        clickId: metadata.impact_click_id,
        capturedAt: metadata.impact_click_at,
      },
      nowDate().getTime(),
    );
    if (impact) {
      await set(persistOrgImpactAttribution$, orgId, impact, signal);
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return;
    }
    await set(writeDb$).transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('stripe_customer_' || ${orgId}))`,
      );
      signal.throwIfAborted();
      const [row] = await tx
        .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      if (row?.stripeCustomerId) {
        const current = await readOrgImpactMetadata(tx, orgId, signal);
        await updateImpactCustomer(
          row.stripeCustomerId,
          {
            ...current,
            ...(current.impact_click_id === metadata.impact_click_id &&
            current.impact_click_at === metadata.impact_click_at
              ? {
                  impact_privacy_receipt: metadata.impact_privacy_receipt ?? "",
                  impact_privacy_user_id: metadata.impact_privacy_user_id ?? "",
                }
              : {}),
          },
          signal,
        );
      }
    });
    signal.throwIfAborted();
  },
);
