import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import {
  getStripeClient,
  isStripeResourceMissingError,
  type StripeClient,
  type StripeCreditNote,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripeRefund,
  type StripeSubscription,
} from "../external/stripe-client";
import { settle } from "../utils";

const ORG_DELETE_ORG_METADATA_KEY = "vm0_org_delete_org_id";
const ORG_DELETE_AT_METADATA_KEY = "vm0_org_delete_at";
const ORG_DELETE_REFUND_PURPOSE = "org_deletion_prorated_refund";
const PLAN_CANCEL_ADD_ON_ORG_METADATA_KEY = "vm0_plan_cancel_add_on_org_id";
const PLAN_CANCEL_ADD_ON_AT_METADATA_KEY = "vm0_plan_cancel_add_on_at";
const PLAN_CANCEL_ADD_ON_REFUND_PURPOSE =
  "plan_cancellation_add_on_prorated_refund";
const STRIPE_PAGE_SIZE = 100;

interface SubscriptionCancellationReason {
  readonly markerOrgIdMetadataKey: string;
  readonly markerAtMetadataKey: string;
  readonly refundPurpose: string;
  readonly refundAtMetadataKey: string;
  readonly operationIdempotencyPrefix: string;
  readonly refundIdempotencyPrefix: string;
  readonly description: string;
}

const ORG_DELETION_REASON = Object.freeze({
  markerOrgIdMetadataKey: ORG_DELETE_ORG_METADATA_KEY,
  markerAtMetadataKey: ORG_DELETE_AT_METADATA_KEY,
  refundPurpose: ORG_DELETE_REFUND_PURPOSE,
  refundAtMetadataKey: "deletionAt",
  operationIdempotencyPrefix: "org-delete",
  refundIdempotencyPrefix: "org-delete-refund",
  description: "organization deletion",
} satisfies SubscriptionCancellationReason);

const PLAN_CANCELLATION_ADD_ON_REASON = Object.freeze({
  markerOrgIdMetadataKey: PLAN_CANCEL_ADD_ON_ORG_METADATA_KEY,
  markerAtMetadataKey: PLAN_CANCEL_ADD_ON_AT_METADATA_KEY,
  refundPurpose: PLAN_CANCEL_ADD_ON_REFUND_PURPOSE,
  refundAtMetadataKey: "canceledAt",
  operationIdempotencyPrefix: "plan-cancel-add-on",
  refundIdempotencyPrefix: "plan-cancel-add-on-refund",
  description: "plan cancellation",
} satisfies SubscriptionCancellationReason);

interface OrgBillingReferences {
  readonly customerIds: ReadonlySet<string>;
  readonly subscriptionIds: ReadonlySet<string>;
}

function nextPageCursor<T extends { readonly id: string }>(
  page: { readonly data: readonly T[]; readonly has_more: boolean },
  resource: string,
): string | null {
  if (!page.has_more) {
    return null;
  }
  const last = page.data.at(-1);
  if (!last) {
    throw new Error(`${resource} returned an incomplete page`);
  }
  return last.id;
}

function addIfPresent(target: Set<string>, value: string | null): void {
  if (value) {
    target.add(value);
  }
}

async function loadOrgBillingReferences(
  db: ReadonlyDb,
  orgId: string,
): Promise<OrgBillingReferences> {
  const [
    metadataRows,
    planRows,
    allowanceRows,
    concurrencyRows,
    usagePackRows,
  ] = await Promise.all([
    db
      .select({
        customerId: orgMetadata.stripeCustomerId,
        subscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId)),
    db
      .select({ subscriptionId: orgPlanEntitlements.stripeSubscriptionId })
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId)),
    db
      .select({
        customerId: orgUsageAllowanceEntitlements.stripeCustomerId,
        subscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      })
      .from(orgUsageAllowanceEntitlements)
      .where(eq(orgUsageAllowanceEntitlements.orgId, orgId)),
    db
      .select({
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(eq(orgConcurrencySubscriptions.orgId, orgId)),
    db
      .select({
        customerId: usagePackSubscriptions.stripeCustomerId,
        subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
      })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.orgId, orgId)),
  ]);

  const customerIds = new Set<string>();
  const subscriptionIds = new Set<string>();
  for (const row of [...metadataRows, ...allowanceRows, ...usagePackRows]) {
    addIfPresent(customerIds, row.customerId);
    addIfPresent(subscriptionIds, row.subscriptionId);
  }
  for (const row of [...planRows, ...concurrencyRows]) {
    addIfPresent(subscriptionIds, row.subscriptionId);
  }
  return { customerIds, subscriptionIds };
}

async function listCustomerSubscriptions(
  stripe: StripeClient,
  customerId: string,
  signal: AbortSignal,
): Promise<readonly StripeSubscription[]> {
  const subscriptions: StripeSubscription[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: STRIPE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    subscriptions.push(...page.data);
    const nextCursor = nextPageCursor(
      page,
      `Stripe customer ${customerId} subscriptions`,
    );
    if (nextCursor === null) {
      return subscriptions;
    }
    startingAfter = nextCursor;
  }
}

async function retrieveSubscriptionIfPresent(
  stripe: StripeClient,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<StripeSubscription | null> {
  const result = await settle(stripe.subscriptions.retrieve(subscriptionId));
  signal.throwIfAborted();
  if (result.ok) {
    return result.value;
  }
  if (isStripeResourceMissingError(result.error)) {
    return null;
  }
  throw result.error;
}

async function loadOrgSubscriptions(
  stripe: StripeClient,
  references: OrgBillingReferences,
  signal: AbortSignal,
): Promise<readonly StripeSubscription[]> {
  const subscriptions = new Map<string, StripeSubscription>();
  for (const customerId of references.customerIds) {
    const listed = await listCustomerSubscriptions(stripe, customerId, signal);
    for (const subscription of listed) {
      subscriptions.set(subscription.id, subscription);
    }
  }
  for (const subscriptionId of references.subscriptionIds) {
    if (subscriptions.has(subscriptionId)) {
      continue;
    }
    const subscription = await retrieveSubscriptionIfPresent(
      stripe,
      subscriptionId,
      signal,
    );
    if (subscription) {
      subscriptions.set(subscription.id, subscription);
    }
  }
  return [...subscriptions.values()];
}

function markedCancellationTimestamp(
  subscription: StripeSubscription,
  orgId: string,
  reason: SubscriptionCancellationReason,
): number | null {
  const metadata = subscription.metadata ?? {};
  const markedOrgId = metadata[reason.markerOrgIdMetadataKey];
  if (!markedOrgId) {
    return null;
  }
  if (markedOrgId !== orgId) {
    throw new Error(
      `Stripe subscription ${subscription.id} belongs to another ${reason.description}`,
    );
  }
  const timestamp = Number(metadata[reason.markerAtMetadataKey]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(
      `Stripe subscription ${subscription.id} has an invalid ${reason.description} timestamp`,
    );
  }
  return timestamp;
}

function isTerminalSubscription(subscription: StripeSubscription): boolean {
  return (
    subscription.status === "canceled" ||
    subscription.status === "ended" ||
    subscription.status === "incomplete_expired"
  );
}

async function markSubscriptionForCancellation(
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly cancellationTimestamp: number;
  },
  reason: SubscriptionCancellationReason,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await settle(
    stripe.subscriptions.update(
      args.subscriptionId,
      {
        metadata: {
          [reason.markerOrgIdMetadataKey]: args.orgId,
          [reason.markerAtMetadataKey]: String(args.cancellationTimestamp),
        },
      },
      {
        idempotencyKey: `${reason.operationIdempotencyPrefix}:${args.orgId}:${args.subscriptionId}:mark`,
      },
    ),
  );
  signal.throwIfAborted();
  if (result.ok) {
    return true;
  }
  if (isStripeResourceMissingError(result.error)) {
    return false;
  }
  throw result.error;
}

async function cancelSubscriptionImmediately(
  stripe: StripeClient,
  args: { readonly orgId: string; readonly subscriptionId: string },
  reason: SubscriptionCancellationReason,
  signal: AbortSignal,
): Promise<void> {
  const result = await settle(
    stripe.subscriptions.cancel(
      args.subscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: `${reason.operationIdempotencyPrefix}:${args.orgId}:${args.subscriptionId}:cancel`,
      },
    ),
  );
  signal.throwIfAborted();
  if (!result.ok && !isStripeResourceMissingError(result.error)) {
    throw result.error;
  }
}

async function listPaidSubscriptionInvoices(
  stripe: StripeClient,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<readonly StripeInvoice[]> {
  const invoices: StripeInvoice[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: STRIPE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    invoices.push(...page.data);
    const nextCursor = nextPageCursor(
      page,
      `Stripe subscription ${subscriptionId} invoices`,
    );
    if (nextCursor === null) {
      return invoices;
    }
    startingAfter = nextCursor;
  }
}

function proratedLineAmount(
  line: StripeInvoiceLine,
  deletionTimestamp: number,
): number {
  if (line.parent?.type !== "subscription_item_details") {
    return 0;
  }
  const start = line.period.start;
  const end = line.period.end;
  if (end <= start || deletionTimestamp >= end) {
    return 0;
  }
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error("Stripe invoice line has an invalid amount");
  }
  const remaining = end - Math.max(start, deletionTimestamp);
  const numerator = amount * remaining;
  if (!Number.isSafeInteger(numerator)) {
    throw new Error("Stripe invoice line proration exceeds safe precision");
  }
  return numerator / (end - start);
}

function proratedInvoiceAdjustment(
  invoice: StripeInvoice,
  lines: readonly StripeInvoiceLine[],
  deletionTimestamp: number,
): number {
  if (invoice.status !== "paid") {
    throw new Error(`Stripe invoice ${invoice.id} is not paid`);
  }
  const amount = lines.reduce((total, line) => {
    return total + proratedLineAmount(line, deletionTimestamp);
  }, 0);
  if (!Number.isFinite(amount)) {
    throw new Error(`Stripe invoice ${invoice.id} has an invalid proration`);
  }
  return amount;
}

interface InvoiceProration {
  readonly invoice: StripeInvoice;
  readonly amount: number;
}

interface InvoiceRefund {
  readonly invoice: StripeInvoice;
  readonly amount: number;
}

function allocateInvoiceRefunds(
  prorations: readonly InvoiceProration[],
): readonly InvoiceRefund[] {
  // A negative downgrade invoice becomes Stripe customer balance. Include its
  // unused-time adjustment before allocating the remaining cash refund.
  const total = prorations.reduce((sum, proration) => {
    return sum + proration.amount;
  }, 0);
  if (!Number.isFinite(total)) {
    throw new Error("Stripe subscription has an invalid proration");
  }
  const refundableTotal = Math.max(0, Math.floor(total));
  if (!Number.isSafeInteger(refundableTotal)) {
    throw new Error("Stripe subscription proration exceeds safe precision");
  }

  let remaining = refundableTotal;
  const allocations = prorations.map((proration) => {
    const baseAmount = Math.max(0, Math.floor(proration.amount));
    if (!Number.isSafeInteger(baseAmount)) {
      throw new Error(
        `Stripe invoice ${proration.invoice.id} proration exceeds safe precision`,
      );
    }
    const amount = Math.min(baseAmount, remaining);
    remaining -= amount;
    return { ...proration, amount };
  });

  const fractionalAllocations = prorations
    .map((proration, index) => {
      return {
        index,
        remainder:
          proration.amount > 0
            ? proration.amount - Math.floor(proration.amount)
            : 0,
      };
    })
    .filter(({ remainder }) => {
      return remainder > 0;
    })
    .sort((left, right) => {
      return right.remainder - left.remainder || left.index - right.index;
    });
  for (const { index } of fractionalAllocations) {
    if (remaining === 0) {
      break;
    }
    const allocation = allocations[index];
    if (!allocation) {
      throw new Error("Stripe subscription refund allocation is incomplete");
    }
    allocations[index] = { ...allocation, amount: allocation.amount + 1 };
    remaining -= 1;
  }
  if (remaining !== 0) {
    throw new Error("Stripe subscription refund allocation is incomplete");
  }
  return allocations.filter(({ amount }) => {
    return amount > 0;
  });
}

async function listCompleteInvoiceLines(
  stripe: StripeClient,
  invoice: StripeInvoice,
  signal: AbortSignal,
): Promise<readonly StripeInvoiceLine[]> {
  if (!invoice.lines.has_more) {
    return invoice.lines.data;
  }
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.listLineItems(invoice.id, {
      limit: STRIPE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    lines.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (!page.has_more) {
      return lines;
    }
    if (!last?.id) {
      throw new Error(
        `Stripe invoice ${invoice.id} returned an incomplete line-item page`,
      );
    }
    startingAfter = last.id;
  }
}

function refundMetadata(args: {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly cancellationTimestamp: number;
  readonly reason: SubscriptionCancellationReason;
}): Record<string, string> {
  return {
    purpose: args.reason.refundPurpose,
    orgId: args.orgId,
    subscriptionId: args.subscriptionId,
    [args.reason.refundAtMetadataKey]: String(args.cancellationTimestamp),
  };
}

function matchingDeletionCreditNote(
  creditNote: StripeCreditNote,
  metadata: Record<string, string>,
): boolean {
  return Object.entries(metadata).every(([key, value]) => {
    return creditNote.metadata?.[key] === value;
  });
}

async function findDeletionCreditNote(
  stripe: StripeClient,
  invoiceId: string,
  metadata: Record<string, string>,
  signal: AbortSignal,
): Promise<StripeCreditNote | null> {
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.creditNotes.list({
      invoice: invoiceId,
      limit: STRIPE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    const existing = page.data.find((creditNote) => {
      return matchingDeletionCreditNote(creditNote, metadata);
    });
    if (existing) {
      return existing;
    }
    const nextCursor = nextPageCursor(
      page,
      `Stripe invoice ${invoiceId} credit notes`,
    );
    if (nextCursor === null) {
      return null;
    }
    startingAfter = nextCursor;
  }
}

async function resolveRefund(
  stripe: StripeClient,
  refund: string | StripeRefund,
): Promise<StripeRefund> {
  return typeof refund === "string"
    ? await stripe.refunds.retrieve(refund)
    : refund;
}

async function assertCreditNoteRefundSucceeded(
  stripe: StripeClient,
  creditNote: StripeCreditNote,
): Promise<void> {
  if (
    creditNote.status !== "issued" ||
    creditNote.post_payment_amount <= 0 ||
    creditNote.refunds.length === 0
  ) {
    throw new Error(`Stripe credit note ${creditNote.id} has no refund`);
  }
  const refundedAmount = creditNote.refunds.reduce((total, entry) => {
    return total + entry.amount_refunded;
  }, 0);
  if (refundedAmount !== creditNote.post_payment_amount) {
    throw new Error(`Stripe credit note ${creditNote.id} has a partial refund`);
  }
  for (const entry of creditNote.refunds) {
    const refund = await resolveRefund(stripe, entry.refund);
    if (refund.status !== "succeeded") {
      throw new Error(
        `Stripe refund ${refund.id} has non-terminal status ${String(refund.status)}`,
      );
    }
  }
}

async function refundInvoiceProration(
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly cancellationTimestamp: number;
    readonly invoice: StripeInvoice;
    readonly amount: number;
  },
  reason: SubscriptionCancellationReason,
  signal: AbortSignal,
): Promise<void> {
  const metadata = refundMetadata({ ...args, reason });
  const existing = await findDeletionCreditNote(
    stripe,
    args.invoice.id,
    metadata,
    signal,
  );
  if (existing) {
    await assertCreditNoteRefundSucceeded(stripe, existing);
    signal.throwIfAborted();
    return;
  }
  const commonParams = {
    invoice: args.invoice.id,
    amount: args.amount,
    email_type: "none" as const,
    reason: "order_change" as const,
    metadata,
  };
  const preview = await stripe.creditNotes.preview(commonParams);
  signal.throwIfAborted();
  if (preview.pre_payment_amount !== 0 || preview.post_payment_amount <= 0) {
    throw new Error(
      `Stripe invoice ${args.invoice.id} proration is not fully refundable`,
    );
  }
  const creditNote = await stripe.creditNotes.create(
    { ...commonParams, refund_amount: preview.post_payment_amount },
    {
      idempotencyKey: `${reason.refundIdempotencyPrefix}:${args.orgId}:${args.subscriptionId}:${args.invoice.id}:${args.cancellationTimestamp}`,
    },
  );
  signal.throwIfAborted();
  await assertCreditNoteRefundSucceeded(stripe, creditNote);
  signal.throwIfAborted();
}

async function refundSubscriptionProration(
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly cancellationTimestamp: number;
  },
  reason: SubscriptionCancellationReason,
  signal: AbortSignal,
): Promise<void> {
  const invoices = await listPaidSubscriptionInvoices(
    stripe,
    args.subscriptionId,
    signal,
  );
  const prorations: InvoiceProration[] = [];
  for (const invoice of invoices) {
    const lines = await listCompleteInvoiceLines(stripe, invoice, signal);
    prorations.push({
      invoice,
      amount: proratedInvoiceAdjustment(
        invoice,
        lines,
        args.cancellationTimestamp,
      ),
    });
  }
  for (const { invoice, amount } of allocateInvoiceRefunds(prorations)) {
    await refundInvoiceProration(
      stripe,
      { ...args, invoice, amount },
      reason,
      signal,
    );
  }
}

async function cancelAndRefundSubscription(
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscription: StripeSubscription;
    readonly defaultCancellationTimestamp: number;
  },
  reason: SubscriptionCancellationReason,
  signal: AbortSignal,
): Promise<void> {
  const markedTimestamp = markedCancellationTimestamp(
    args.subscription,
    args.orgId,
    reason,
  );
  if (isTerminalSubscription(args.subscription) && markedTimestamp === null) {
    return;
  }
  const cancellationTimestamp =
    markedTimestamp ?? args.defaultCancellationTimestamp;
  if (markedTimestamp === null) {
    const marked = await markSubscriptionForCancellation(
      stripe,
      {
        orgId: args.orgId,
        subscriptionId: args.subscription.id,
        cancellationTimestamp,
      },
      reason,
      signal,
    );
    if (!marked) {
      return;
    }
  }
  if (!isTerminalSubscription(args.subscription)) {
    await cancelSubscriptionImmediately(
      stripe,
      { orgId: args.orgId, subscriptionId: args.subscription.id },
      reason,
      signal,
    );
  }
  await refundSubscriptionProration(
    stripe,
    {
      orgId: args.orgId,
      subscriptionId: args.subscription.id,
      cancellationTimestamp,
    },
    reason,
    signal,
  );
}

async function loadOrgAddOnSubscriptionIds(
  db: ReadonlyDb,
  orgId: string,
  planSubscriptionId: string,
): Promise<ReadonlySet<string>> {
  const [concurrencyRows, usagePackRows] = await Promise.all([
    db
      .select({
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(eq(orgConcurrencySubscriptions.orgId, orgId)),
    db
      .select({ subscriptionId: usagePackSubscriptions.stripeSubscriptionId })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.orgId, orgId)),
  ]);
  const subscriptionIds = new Set<string>();
  for (const row of [...concurrencyRows, ...usagePackRows]) {
    addIfPresent(subscriptionIds, row.subscriptionId);
  }
  subscriptionIds.delete(planSubscriptionId);
  return subscriptionIds;
}

export function isOrgDeletionBillingCancellation(
  subscription: {
    readonly metadata?: Record<string, string> | null;
  },
  orgId: string,
): boolean {
  return subscription.metadata?.[ORG_DELETE_ORG_METADATA_KEY] === orgId;
}

/**
 * Cancels paid add-on subscriptions when their owning Plan ends. Usage
 * allowance subscriptions belong to Custom plans and are intentionally
 * excluded. A usage pack that shares the Plan subscription is also excluded
 * because Stripe has already canceled it as part of the Plan.
 */
export async function cancelAndRefundOrgAddOnsForPlanCancellation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly planSubscriptionId: string;
    readonly cancellationTimestamp: number;
  },
  signal: AbortSignal,
): Promise<void> {
  const subscriptionIds = await loadOrgAddOnSubscriptionIds(
    db,
    args.orgId,
    args.planSubscriptionId,
  );
  signal.throwIfAborted();
  if (subscriptionIds.size === 0) {
    return;
  }
  const stripe = getStripeClient();
  const subscriptions = await loadOrgSubscriptions(
    stripe,
    { customerIds: new Set(), subscriptionIds },
    signal,
  );
  for (const subscription of subscriptions) {
    await cancelAndRefundSubscription(
      stripe,
      {
        orgId: args.orgId,
        subscription,
        defaultCancellationTimestamp: args.cancellationTimestamp,
      },
      PLAN_CANCELLATION_ADD_ON_REASON,
      signal,
    );
  }
}

/**
 * Cancels every Stripe subscription associated with an organization and
 * refunds only unused, paid subscription time. One-time purchases are not
 * subscription invoice lines and are intentionally excluded.
 */
export async function cancelAndRefundOrgBillingForDeletion(
  db: ReadonlyDb,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const references = await loadOrgBillingReferences(db, orgId);
  signal.throwIfAborted();
  if (
    references.customerIds.size === 0 &&
    references.subscriptionIds.size === 0
  ) {
    return;
  }
  const stripe = getStripeClient();
  const subscriptions = await loadOrgSubscriptions(stripe, references, signal);
  const markedTimestamps = subscriptions.flatMap((subscription) => {
    const timestamp = markedCancellationTimestamp(
      subscription,
      orgId,
      ORG_DELETION_REASON,
    );
    return timestamp === null ? [] : [timestamp];
  });
  const defaultCancellationTimestamp =
    markedTimestamps.length > 0
      ? Math.min(...markedTimestamps)
      : Math.floor(nowDate().getTime() / 1000);
  for (const subscription of subscriptions) {
    await cancelAndRefundSubscription(
      stripe,
      { orgId, subscription, defaultCancellationTimestamp },
      ORG_DELETION_REASON,
      signal,
    );
  }
}
