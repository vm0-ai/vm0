import { usagePackCreditGrants } from "@vm0/db/schema/usage-pack-credit-grant";
import {
  usagePackCreditRefunds,
  type UsagePackCreditRefundSourceType,
} from "@vm0/db/schema/usage-pack-credit-refund";
import { usagePackInvitationPurchases } from "@vm0/db/schema/usage-pack-subscription";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeCreditNote,
  type StripeCreditNoteParams,
  type StripeRefund,
} from "../external/stripe-client";

const CREDITS_PER_CENT = 10;
const RECONCILIATION_LIMIT = 100;

type UsagePackCreditRefundRow = typeof usagePackCreditRefunds.$inferSelect;
type UsagePackCreditGrantRow = typeof usagePackCreditGrants.$inferSelect;
type CreditRefundSourceStore = Pick<Db, "insert" | "select">;
type CreditRefundStore = Pick<Db, "insert" | "select" | "update">;

export type UsagePackCreditRefundSource =
  | {
      readonly type: "invoice";
      readonly invoiceId: string;
      readonly invoiceLineId?: string | null;
      readonly amountCents: number;
    }
  | {
      readonly type: "payment_intent";
      readonly paymentIntentId: string;
      readonly amountCents: number;
    };

async function usagePackCreditRefundSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_credit_refunds') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

function sourceColumns(source: UsagePackCreditRefundSource): {
  readonly sourceType: UsagePackCreditRefundSourceType;
  readonly stripeInvoiceId: string | null;
  readonly stripeInvoiceLineId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly sourceAmountCents: number;
} {
  if (!Number.isSafeInteger(source.amountCents) || source.amountCents < 0) {
    throw new Error("Usage pack refund source amount cannot be negative");
  }
  if (source.type === "invoice") {
    return {
      sourceType: source.type,
      stripeInvoiceId: source.invoiceId,
      stripeInvoiceLineId: source.invoiceLineId ?? null,
      stripePaymentIntentId: null,
      sourceAmountCents: source.amountCents,
    };
  }
  return {
    sourceType: source.type,
    stripeInvoiceId: null,
    stripeInvoiceLineId: null,
    stripePaymentIntentId: source.paymentIntentId,
    sourceAmountCents: source.amountCents,
  };
}

function refundSourceMatches(
  row: UsagePackCreditRefundRow,
  source: ReturnType<typeof sourceColumns>,
  args: { readonly orgId: string; readonly userId: string },
): boolean {
  return (
    row.orgId === args.orgId &&
    row.userId === args.userId &&
    row.sourceType === source.sourceType &&
    row.stripeInvoiceId === source.stripeInvoiceId &&
    row.stripeInvoiceLineId === source.stripeInvoiceLineId &&
    row.stripePaymentIntentId === source.stripePaymentIntentId &&
    row.sourceAmountCents === source.sourceAmountCents
  );
}

export async function ensureUsagePackCreditRefundSource(
  db: CreditRefundSourceStore,
  args: {
    readonly creditGrantId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly source: UsagePackCreditRefundSource;
  },
): Promise<void> {
  if (!(await usagePackCreditRefundSchemaAvailable(db))) {
    return;
  }
  const source = sourceColumns(args.source);
  const [inserted] = await db
    .insert(usagePackCreditRefunds)
    .values({
      creditGrantId: args.creditGrantId,
      orgId: args.orgId,
      userId: args.userId,
      ...source,
    })
    .onConflictDoNothing({ target: usagePackCreditRefunds.creditGrantId })
    .returning();
  if (inserted) {
    return;
  }
  const [existing] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, args.creditGrantId))
    .limit(1);
  if (!existing || !refundSourceMatches(existing, source, args)) {
    throw new Error("Usage pack credit refund source conflict");
  }
}

function legacyInvoiceId(idempotencyKey: string): string | null {
  const renewal = /^usage-pack:([^:]+):[^:]+:purchased$/.exec(idempotencyKey);
  if (renewal?.[1]) {
    return renewal[1];
  }
  const allocationChange = /^usage-pack-change:[^:]+:([^:]+):purchased$/.exec(
    idempotencyKey,
  );
  if (allocationChange?.[1]) {
    return allocationChange[1];
  }
  const subscriptionChange =
    /^usage-pack-subscription-change:[^:]+:[^:]+:([^:]+):purchased$/.exec(
      idempotencyKey,
    );
  return subscriptionChange?.[1] ?? null;
}

function legacyInvitationPurchaseId(idempotencyKey: string): string | null {
  const match = /^usage-pack-invitation:([^:]+):purchased$/.exec(
    idempotencyKey,
  );
  return match?.[1] ?? null;
}

async function inferLegacyRefundSource(
  db: Pick<Db, "select">,
  grant: UsagePackCreditGrantRow,
): Promise<UsagePackCreditRefundSource> {
  const invitationPurchaseId = legacyInvitationPurchaseId(grant.idempotencyKey);
  if (invitationPurchaseId) {
    const [purchase] = await db
      .select({
        orgId: usagePackInvitationPurchases.orgId,
        acceptedUserId: usagePackInvitationPurchases.acceptedUserId,
        amountPaidCents: usagePackInvitationPurchases.amountPaidCents,
        stripePaymentIntentId:
          usagePackInvitationPurchases.stripePaymentIntentId,
      })
      .from(usagePackInvitationPurchases)
      .where(eq(usagePackInvitationPurchases.id, invitationPurchaseId))
      .limit(1);
    if (
      !purchase ||
      purchase.orgId !== grant.orgId ||
      purchase.acceptedUserId !== grant.userId ||
      !purchase.amountPaidCents ||
      !purchase.stripePaymentIntentId
    ) {
      throw new Error(
        `Usage pack grant ${grant.id} has no refundable invitation payment`,
      );
    }
    return {
      type: "payment_intent",
      paymentIntentId: purchase.stripePaymentIntentId,
      amountCents: purchase.amountPaidCents,
    };
  }

  const invoiceId = legacyInvoiceId(grant.idempotencyKey);
  const amountCents = Math.floor(grant.originalAmount / CREDITS_PER_CENT);
  if (!invoiceId || amountCents <= 0) {
    throw new Error(
      `Usage pack grant ${grant.id} has no refundable Stripe source`,
    );
  }
  return { type: "invoice", invoiceId, amountCents };
}

async function loadRefundSource(
  db: CreditRefundStore,
  grant: UsagePackCreditGrantRow,
): Promise<UsagePackCreditRefundRow> {
  const [existing] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
    .limit(1);
  if (existing) {
    return existing;
  }
  const source = await inferLegacyRefundSource(db, grant);
  await ensureUsagePackCreditRefundSource(db, {
    creditGrantId: grant.id,
    orgId: grant.orgId,
    userId: grant.userId,
    source,
  });
  const [created] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
    .limit(1);
  if (!created) {
    throw new Error(`Usage pack grant ${grant.id} refund source was not saved`);
  }
  return created;
}

export async function prepareUsagePackMemberCreditRefunds(
  db: CreditRefundStore,
  args: { readonly orgId: string; readonly userId: string },
): Promise<number> {
  if (!(await usagePackCreditRefundSchemaAvailable(db))) {
    return 0;
  }
  const at = nowDate();
  const grants = await db
    .select()
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        eq(usagePackCreditGrants.userId, args.userId),
        eq(usagePackCreditGrants.grantType, "purchased"),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    )
    .for("update");

  let prepared = 0;
  for (const grant of grants) {
    const source = await loadRefundSource(db, grant);
    if (source.status !== "available") {
      continue;
    }
    const requestedAmountCents = Math.floor(
      (source.sourceAmountCents * grant.remainingAmount) / grant.originalAmount,
    );
    if (requestedAmountCents <= 0) {
      continue;
    }
    const rows = await db
      .update(usagePackCreditRefunds)
      .set({
        status: "pending",
        refundCredits: grant.remainingAmount,
        requestedAmountCents,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackCreditRefunds.creditGrantId, grant.id),
          eq(usagePackCreditRefunds.status, "available"),
        ),
      )
      .returning({ creditGrantId: usagePackCreditRefunds.creditGrantId });
    prepared += rows.length;
  }
  return prepared;
}

function creditNoteLineParams(
  refund: UsagePackCreditRefundRow,
): Pick<StripeCreditNoteParams, "amount" | "lines"> {
  if (!refund.requestedAmountCents) {
    throw new Error(`Usage pack refund ${refund.creditGrantId} has no amount`);
  }
  return refund.stripeInvoiceLineId
    ? {
        lines: [
          {
            type: "invoice_line_item",
            invoice_line_item: refund.stripeInvoiceLineId,
            amount: refund.requestedAmountCents,
          },
        ],
      }
    : { amount: refund.requestedAmountCents };
}

function creditNoteRefundId(creditNote: StripeCreditNote): string | null {
  const refund = creditNote.refunds[0]?.refund;
  return typeof refund === "string" ? refund : (refund?.id ?? null);
}

async function markRefundSucceeded(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  stripeRefundId: string,
  refundedAmountCents: number,
): Promise<void> {
  const at = nowDate();
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "succeeded",
      stripeRefundId,
      refundedAmountCents,
      failureReason: null,
      refundedAt: at,
      updatedAt: at,
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
}

async function applyPaymentIntentRefundState(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  refund: StripeRefund,
): Promise<void> {
  if (!row.requestedAmountCents) {
    throw new Error(`Usage pack refund ${row.creditGrantId} has no amount`);
  }
  if (refund.status === "succeeded") {
    await markRefundSucceeded(db, row, refund.id, row.requestedAmountCents);
    return;
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await db
      .update(usagePackCreditRefunds)
      .set({
        status: "pending",
        stripeRefundId: null,
        attempt: row.attempt + 1,
        failureReason: `stripe_refund_${refund.status}`,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
    return;
  }
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "processing",
      stripeRefundId: refund.id,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
}

async function applyInvoiceRefundState(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  refund: StripeRefund,
  refundedAmountCents: number,
): Promise<void> {
  if (refund.status === "succeeded") {
    await markRefundSucceeded(db, row, refund.id, refundedAmountCents);
    return;
  }
  await db
    .update(usagePackCreditRefunds)
    .set({
      status:
        refund.status === "failed" || refund.status === "canceled"
          ? "failed"
          : "processing",
      stripeRefundId: refund.id,
      refundedAmountCents,
      failureReason:
        refund.status === "failed" || refund.status === "canceled"
          ? `stripe_refund_${refund.status}`
          : null,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
}

async function processPaymentIntentRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  if (!row.stripePaymentIntentId || !row.requestedAmountCents) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has an invalid PaymentIntent source`,
    );
  }
  const stripe = getStripeClient();
  const refund = row.stripeRefundId
    ? await stripe.refunds.retrieve(row.stripeRefundId)
    : await stripe.refunds.create(
        {
          payment_intent: row.stripePaymentIntentId,
          amount: row.requestedAmountCents,
          metadata: {
            purpose: "usage_pack_member_credit_refund",
            orgId: row.orgId,
            userId: row.userId,
            creditGrantId: row.creditGrantId,
          },
        },
        {
          idempotencyKey: `usage-pack-credit-refund:${row.creditGrantId}:${row.attempt}`,
        },
      );
  await applyPaymentIntentRefundState(db, row, refund);
}

async function loadOrCreateCreditNote(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
): Promise<StripeCreditNote> {
  const stripe = getStripeClient();
  if (row.stripeCreditNoteId) {
    return await stripe.creditNotes.retrieve(row.stripeCreditNoteId);
  }
  if (!row.stripeInvoiceId) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has no Stripe invoice`,
    );
  }
  const lineParams = creditNoteLineParams(row);
  const commonParams = {
    invoice: row.stripeInvoiceId,
    ...lineParams,
    email_type: "none" as const,
    reason: "order_change" as const,
    metadata: {
      purpose: "usage_pack_member_credit_refund",
      orgId: row.orgId,
      userId: row.userId,
      creditGrantId: row.creditGrantId,
    },
  };
  let refundAmountCents = row.refundedAmountCents;
  if (refundAmountCents === null) {
    const preview = await stripe.creditNotes.preview(commonParams);
    if (preview.pre_payment_amount !== 0 || preview.post_payment_amount <= 0) {
      throw new Error(
        `Usage pack refund ${row.creditGrantId} credit note is not fully refundable`,
      );
    }
    refundAmountCents = preview.post_payment_amount;
    await db
      .update(usagePackCreditRefunds)
      .set({ refundedAmountCents: refundAmountCents, updatedAt: nowDate() })
      .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
  }
  return await stripe.creditNotes.create(
    { ...commonParams, refund_amount: refundAmountCents },
    {
      idempotencyKey: `usage-pack-credit-refund:${row.creditGrantId}:${row.attempt}`,
    },
  );
}

async function processInvoiceRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  const creditNote = await loadOrCreateCreditNote(db, row);
  if (creditNote.status !== "issued" || creditNote.post_payment_amount <= 0) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has an invalid credit note`,
    );
  }
  const stripeRefundId = creditNoteRefundId(creditNote);
  if (!stripeRefundId) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} credit note has no refund`,
    );
  }
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "processing",
      stripeCreditNoteId: creditNote.id,
      stripeRefundId,
      refundedAmountCents: creditNote.post_payment_amount,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
  const stripeRefund = await getStripeClient().refunds.retrieve(stripeRefundId);
  await applyInvoiceRefundState(
    db,
    row,
    stripeRefund,
    creditNote.post_payment_amount,
  );
}

async function processCreditRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  await db
    .update(usagePackCreditRefunds)
    .set({ status: "processing", updatedAt: nowDate() })
    .where(
      and(
        eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId),
        inArray(usagePackCreditRefunds.status, ["pending", "processing"]),
      ),
    );
  if (row.sourceType === "payment_intent") {
    await processPaymentIntentRefund(db, row);
    return;
  }
  await processInvoiceRefund(db, row);
}

export async function refundUsagePackMemberCredits(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<number> {
  if (!(await usagePackCreditRefundSchemaAvailable(db))) {
    return 0;
  }
  signal.throwIfAborted();
  const refunds = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(
      and(
        eq(usagePackCreditRefunds.orgId, args.orgId),
        eq(usagePackCreditRefunds.userId, args.userId),
        inArray(usagePackCreditRefunds.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(usagePackCreditRefunds.createdAt));
  signal.throwIfAborted();
  for (const refund of refunds) {
    await processCreditRefund(db, refund);
    signal.throwIfAborted();
  }
  return refunds.length;
}

export async function reconcileUsagePackCreditRefunds(
  db: Db,
  signal: AbortSignal,
): Promise<number> {
  if (!(await usagePackCreditRefundSchemaAvailable(db))) {
    return 0;
  }
  signal.throwIfAborted();
  const refunds = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(inArray(usagePackCreditRefunds.status, ["pending", "processing"]))
    .orderBy(asc(usagePackCreditRefunds.updatedAt))
    .limit(RECONCILIATION_LIMIT);
  signal.throwIfAborted();
  for (const refund of refunds) {
    await processCreditRefund(db, refund);
    signal.throwIfAborted();
  }
  return refunds.length;
}
