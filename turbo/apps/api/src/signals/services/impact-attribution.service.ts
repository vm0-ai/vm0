import { command } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  IMPACT_ATTRIBUTION_METADATA_KEY,
  parseImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";

import { getStripeClient } from "../external/stripe-client";
import { writeDb$ } from "../external/db";
import { optionalEnv } from "../../lib/env";
import { authContext$ } from "../auth/auth-context";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const log = logger("impact-attribution");

// Customer creation is called by authenticated billing routes. Bind the click
// to the actual purchaser; never select an arbitrary member of their org.
export const impactStripeMetadata$ = command(
  async (
    { get },
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
      return {};
    }
    const user = result.value.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    const impact = parseImpactAttribution(
      user?.privateMetadata?.[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    return impact
      ? {
          impact_click_id: impact.clickId,
          impact_click_at: impact.capturedAt,
        }
      : {};
  },
);

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
    !customer.deleted &&
    (!customer.metadata.impact_click_at ||
      customer.metadata.impact_click_at < capturedAt)
  ) {
    await stripe.customers.update(customerId, { metadata: { ...metadata } });
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
    if (
      !auth.orgId ||
      auth.orgRole !== "admin" ||
      !optionalEnv("STRIPE_SECRET_KEY")
    ) {
      return;
    }
    const orgId = auth.orgId;
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
        await updateImpactCustomer(row.stripeCustomerId, metadata, signal);
      }
    });
    signal.throwIfAborted();
  },
);
