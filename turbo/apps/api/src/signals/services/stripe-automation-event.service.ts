import {
  stripeInvoicePaidEventConfigSchema,
  stripeInvoiceBillingReasonSchema,
  type StripeInvoiceBillingReason,
} from "@vm0/api-contracts/contracts/zero-workflows";
import type {
  StripeAutomationEventSnapshot,
  StripeAutomationEventSnapshotLine,
  StripeAutomationEventSnapshotMetadata,
} from "@vm0/db/jsonb-contracts/stripe-automation-event";
import { connectors } from "@vm0/db/schema/connector";
import {
  stripeWorkflowAutomationHealth,
  stripeWorkflowDeliveries,
} from "@vm0/db/schema/stripe-automation-event";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { command } from "ccstate";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { ORG_SENTINEL_USER_ID } from "./feature-switches.service";
import { stripeInvoicePaidWorkflowAutomationEnabledForOwnerInDb } from "./stripe-invoice-paid-workflow-automation-feature-switch.service";
import { validateStripeInvoicePaidAutomationBinding } from "./stripe-invoice-paid-workflow-automation.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { storedWorkflowAutomationContext } from "./workflow-automation-context.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import type {
  AutomationRow,
  RunWorkflowAutomationNowArgs,
  RunWorkflowAutomationResult,
} from "./zero-workflow-automation-launch.service";
import { runWorkflowAutomationNow$ } from "./zero-workflow-automation-run.service";

const log = logger("api:stripe-automation-event");

const STRIPE_DELIVERY_BATCH_SIZE = 25;
const STRIPE_DELIVERY_CLAIM_MS = 300_000;
const STRIPE_DELIVERY_RETRY_BASE_MS = 60_000;
const STRIPE_DELIVERY_RETRY_MAX_MS = 21_600_000;
const STRIPE_DELIVERY_RETRY_CUTOFF_MS = 259_200_000;
const STRIPE_OAUTH_METHOD_IDS = ["oauth", "app-oauth"] as const;

const stripeEventTypeSchema = z.object({
  type: z.string().trim().min(1).max(255),
});
const stripeEventModeSchema = z.object({ livemode: z.boolean() });
const stripeUnixTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000);

const stripeSupportedEventBaseSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    type: z.enum(["invoice.paid", "account.application.deauthorized"]),
    account: z.string().trim().min(1).max(255).optional(),
    livemode: z.boolean(),
    created: stripeUnixTimestampSchema,
  })
  .passthrough();

const nullableIdentifierObjectSchema = z
  .object({ id: z.string().trim().min(1).max(255) })
  .passthrough();

const stripeIdentifierValueSchema = z.union([
  z.string(),
  nullableIdentifierObjectSchema,
]);

function optionalStripeSnapshotField<T>(schema: z.ZodType<T>) {
  // Optional Stripe expansions must not invalidate an otherwise usable invoice.
  const nullableSchema = schema.nullable();
  return z
    .preprocess((value) => {
      const parsed = nullableSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }, nullableSchema)
    .optional();
}

const stripeCustomerSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

const stripeCustomerValueSchema = z.union([z.string(), stripeCustomerSchema]);

const stripeLinePriceSchema = z
  .object({
    id: z.string().nullable().optional(),
    product: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    currency: z.string().nullable().optional(),
    unit_amount: z.number().nullable().optional(),
    recurring: z
      .object({ interval: z.string().nullable().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

const stripeLinePricingSchema = z
  .object({
    type: z.string().nullable().optional(),
    price_details: z
      .object({
        price: optionalStripeSnapshotField(stripeIdentifierValueSchema),
        product: optionalStripeSnapshotField(stripeIdentifierValueSchema),
      })
      .nullable()
      .optional(),
    unit_amount_decimal: z.string().nullable().optional(),
  })
  .passthrough();

const stripeInvoiceParentSchema = z
  .object({
    subscription_details: z
      .object({
        subscription: optionalStripeSnapshotField(stripeIdentifierValueSchema),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const stripeInvoicePaymentRelationshipSchema = z
  .object({
    payment_intent: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    charge: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payment_record: optionalStripeSnapshotField(stripeIdentifierValueSchema),
  })
  .passthrough();

const stripeInvoicePaymentValueSchema = z.union([
  stripeIdentifierValueSchema,
  stripeInvoicePaymentRelationshipSchema,
]);

const stripeInvoicePaymentsSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(255).nullable().optional(),
          payment: optionalStripeSnapshotField(stripeInvoicePaymentValueSchema),
          payment_intent: optionalStripeSnapshotField(
            stripeIdentifierValueSchema,
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const stripeInvoiceLineSchema = z
  .object({
    id: z.string().nullable().optional(),
    object: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    quantity: z.number().nullable().optional(),
    amount: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    period: z
      .object({
        start: stripeUnixTimestampSchema.nullable().optional(),
        end: stripeUnixTimestampSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    price: optionalStripeSnapshotField(stripeLinePriceSchema),
    pricing: optionalStripeSnapshotField(stripeLinePricingSchema),
  })
  .passthrough();

const stripeInvoiceSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    object: z.literal("invoice"),
    status: z.string().nullable().optional(),
    billing_reason: z.string().nullable().optional(),
    amount_paid: z.number().nullable().optional(),
    amount_due: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    collection_method: z.string().nullable().optional(),
    hosted_invoice_url: z.string().nullable().optional(),
    invoice_pdf: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    lines: z.object({
      data: z.array(stripeInvoiceLineSchema),
      has_more: z.boolean(),
      total_count: z.number().int().nonnegative().nullable().optional(),
    }),
    customer: optionalStripeSnapshotField(stripeCustomerValueSchema),
    subscription: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payment_intent: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payments: optionalStripeSnapshotField(stripeInvoicePaymentsSchema),
    parent: optionalStripeSnapshotField(stripeInvoiceParentSchema),
  })
  .passthrough();

const stripeInvoicePaidEventBaseSchema = stripeSupportedEventBaseSchema.extend({
  type: z.literal("invoice.paid"),
  data: z.object({ object: stripeInvoiceSchema }).passthrough(),
});

const stripeInvoicePaidEventSchema = stripeInvoicePaidEventBaseSchema.extend({
  account: z.string().trim().min(1).max(255),
  livemode: z.literal(true),
});

const stripeDeauthorizedEventBaseSchema = stripeSupportedEventBaseSchema.extend(
  {
    type: z.literal("account.application.deauthorized"),
    data: z.object({ object: z.unknown() }).passthrough(),
  },
);

const stripeDeauthorizedEventSchema = stripeDeauthorizedEventBaseSchema.extend({
  account: z.string().trim().min(1).max(255),
  livemode: z.literal(true),
});

type StripeWorkflowDeliveryRow = typeof stripeWorkflowDeliveries.$inferSelect;
type StripeWorkflowTransaction = Tx;

type DispatchStripeAutomationEventResult =
  | {
      readonly kind: "ok";
      readonly eventKind: "test" | "ignored" | "deauthorized" | "invoice";
      readonly queued: number;
      readonly duplicates: number;
    }
  | { readonly kind: "bad_request" };

type StripeDeliveryTarget = {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
};

type StripeDeliveryValidation =
  | { readonly kind: "ok"; readonly target: StripeDeliveryTarget }
  | { readonly kind: "skip"; readonly reason: string };

interface ExecuteDueStripeAutomationEventsResult {
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retried: number;
}

interface StripeInvoiceFanoutResult {
  readonly mappedConnectors: number;
  readonly candidates: number;
  readonly matched: number;
  readonly filtered: number;
  readonly queued: number;
  readonly duplicates: number;
}

interface StripeInvoiceFanoutCandidate {
  readonly automation: AutomationRow;
  readonly connectorId: string;
}

function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const parsed = nullableIdentifierObjectSchema.safeParse(value);
  return parsed.success ? parsed.data.id : null;
}

function unixSecondsToIso(value: number | null | undefined): string | null {
  return value === null || value === undefined
    ? null
    : new Date(value * 1000).toISOString();
}

function normalizeMetadata(
  metadata: Record<string, string> | undefined,
): StripeAutomationEventSnapshotMetadata {
  return metadata ?? {};
}

function normalizeLine(
  line: z.infer<typeof stripeInvoiceLineSchema>,
): StripeAutomationEventSnapshotLine {
  const price = stripeLinePriceSchema.safeParse(line.price);
  const pricing = stripeLinePricingSchema.safeParse(line.pricing);
  return {
    id: line.id ?? null,
    type: line.object ?? null,
    description: line.description ?? null,
    quantity: line.quantity ?? null,
    amount: line.amount ?? null,
    currency: line.currency ?? null,
    metadata: normalizeMetadata(line.metadata),
    period:
      line.period === null || line.period === undefined
        ? null
        : {
            start: unixSecondsToIso(line.period.start),
            end: unixSecondsToIso(line.period.end),
          },
    price: price.success
      ? {
          id: price.data.id ?? null,
          productId: identifier(price.data.product),
          currency: price.data.currency ?? null,
          unitAmount: price.data.unit_amount ?? null,
          recurringInterval: price.data.recurring?.interval ?? null,
        }
      : null,
    pricing: pricing.success
      ? {
          type: pricing.data.type ?? null,
          priceId: identifier(pricing.data.price_details?.price),
          productId: identifier(pricing.data.price_details?.product),
          unitAmountDecimal: pricing.data.unit_amount_decimal ?? null,
        }
      : null,
  };
}

function normalizeCustomer(
  value: unknown,
): StripeAutomationEventSnapshot["customer"] {
  if (typeof value === "string") {
    return { id: value, name: null, email: null };
  }
  const customer = stripeCustomerSchema.safeParse(value);
  return customer.success
    ? {
        id: customer.data.id ?? null,
        name: customer.data.name ?? null,
        email: customer.data.email ?? null,
      }
    : null;
}

function normalizePayments(value: unknown): {
  readonly paymentIds: readonly string[];
  readonly paymentIntentIds: readonly string[];
  readonly chargeIds: readonly string[];
  readonly paymentRecordIds: readonly string[];
} {
  const payments = stripeInvoicePaymentsSchema.safeParse(value);
  if (!payments.success) {
    return {
      paymentIds: [],
      paymentIntentIds: [],
      chargeIds: [],
      paymentRecordIds: [],
    };
  }
  const uniqueIds = (ids: readonly (string | null)[]): readonly string[] => {
    return [
      ...new Set(
        ids.filter((id): id is string => {
          return id !== null;
        }),
      ),
    ];
  };
  return {
    paymentIds: uniqueIds(
      payments.data.data.map((payment) => {
        return payment.id ?? identifier(payment.payment);
      }),
    ),
    paymentIntentIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(
          current.success
            ? current.data.payment_intent
            : payment.payment_intent,
        );
      }),
    ),
    chargeIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(current.success ? current.data.charge : null);
      }),
    ),
    paymentRecordIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(current.success ? current.data.payment_record : null);
      }),
    ),
  };
}

function subscriptionId(
  invoice: z.infer<typeof stripeInvoiceSchema>,
): string | null {
  const current = stripeInvoiceParentSchema.safeParse(invoice.parent);
  return (
    identifier(
      current.success ? current.data.subscription_details?.subscription : null,
    ) ?? identifier(invoice.subscription)
  );
}

function invoiceSnapshot(
  event: z.infer<typeof stripeInvoicePaidEventSchema>,
): StripeAutomationEventSnapshot {
  const invoice = event.data.object;
  const payments = normalizePayments(invoice.payments);
  return {
    event: {
      id: event.id,
      type: "invoice.paid",
      createdAt: new Date(event.created * 1000).toISOString(),
      connectedAccountId: event.account,
      livemode: true,
    },
    invoice: {
      id: invoice.id,
      status: invoice.status ?? null,
      billingReason: invoice.billing_reason ?? null,
      amountPaid: invoice.amount_paid ?? null,
      amountDue: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      collectionMethod: invoice.collection_method ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      metadata: normalizeMetadata(invoice.metadata),
      lines: {
        data: invoice.lines.data.map(normalizeLine),
        hasMore: invoice.lines.has_more,
        totalCount: invoice.lines.total_count ?? null,
      },
    },
    customer: normalizeCustomer(invoice.customer),
    relationships: {
      subscriptionId: subscriptionId(invoice),
      paymentIntentId: identifier(invoice.payment_intent),
      paymentIds: payments.paymentIds,
      paymentIntentIds: payments.paymentIntentIds,
      chargeIds: payments.chargeIds,
      paymentRecordIds: payments.paymentRecordIds,
    },
  };
}

function knownBillingReason(
  value: string | null,
): StripeInvoiceBillingReason | null {
  const parsed = stripeInvoiceBillingReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function filterMatches(
  configured: readonly StripeInvoiceBillingReason[] | undefined,
  actual: StripeInvoiceBillingReason | null,
): boolean {
  if (configured === undefined || configured.length === 0) {
    return true;
  }
  return actual !== null && configured.includes(actual);
}

function eventMode(event: unknown): "live" | "test" | "unknown" {
  const parsed = stripeEventModeSchema.safeParse(event);
  if (!parsed.success) {
    return "unknown";
  }
  return parsed.data.livemode ? "live" : "test";
}

async function markStripeConnectorsDeauthorized(
  args: {
    readonly tx: StripeWorkflowTransaction;
    readonly accountId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const updated = await args.tx
    .update(connectors)
    .set({
      needsReconnect: true,
      reconnectReason: "authorization_expired_or_revoked",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectors.connectorSlug, "stripe"),
        inArray(connectors.authMethod, STRIPE_OAUTH_METHOD_IDS),
        eq(connectors.externalId, args.accountId),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated.length;
}

async function insertStripeWorkflowDelivery(
  args: {
    readonly tx: StripeWorkflowTransaction;
    readonly candidate: StripeInvoiceFanoutCandidate;
    readonly snapshot: StripeAutomationEventSnapshot;
    readonly receivedAt: Date;
  },
  signal: AbortSignal,
): Promise<"queued" | "duplicate"> {
  const [delivery] = await args.tx
    .insert(stripeWorkflowDeliveries)
    .values({
      automationId: args.candidate.automation.id,
      connectorId: args.candidate.connectorId,
      stripeAccountId: args.snapshot.event.connectedAccountId,
      livemode: true,
      stripeEventId: args.snapshot.event.id,
      stripeEventCreatedAt: new Date(args.snapshot.event.createdAt),
      billingReason: args.snapshot.invoice.billingReason,
      snapshot: args.snapshot,
      nextAttemptAt: args.receivedAt,
      receivedAt: args.receivedAt,
      createdAt: args.receivedAt,
      updatedAt: args.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: stripeWorkflowDeliveries.id });
  signal.throwIfAborted();
  if (!delivery) {
    return "duplicate";
  }
  await args.tx
    .update(stripeWorkflowAutomationHealth)
    .set({
      latestDeliveryId: delivery.id,
      latestDeliveryStatus: "pending",
      latestDeliveryStatusAt: args.receivedAt,
      updatedAt: args.receivedAt,
    })
    .where(
      eq(
        stripeWorkflowAutomationHealth.automationId,
        args.candidate.automation.id,
      ),
    );
  signal.throwIfAborted();
  return "queued";
}

async function lockMappedStripeConnectors(
  args: {
    readonly tx: StripeWorkflowTransaction;
    readonly accountId: string;
  },
  signal: AbortSignal,
): Promise<readonly { readonly id: string }[]> {
  const mapped = await args.tx
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.connectorSlug, "stripe"),
        inArray(connectors.authMethod, STRIPE_OAUTH_METHOD_IDS),
        eq(connectors.externalId, args.accountId),
      ),
    )
    .orderBy(asc(connectors.id))
    .for("update");
  signal.throwIfAborted();
  return mapped;
}

async function loadStripeInvoiceFanoutCandidates(
  tx: StripeWorkflowTransaction,
  connectorIds: readonly string[],
  signal: AbortSignal,
) {
  const rows = await tx
    .select({
      automation: workflowAutomationColumns(),
      connectorId: connectors.id,
    })
    .from(connectors)
    .innerJoin(
      zeroWorkflowAutomations,
      and(
        eq(zeroWorkflowAutomations.orgId, connectors.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, connectors.userId),
      ),
    )
    .where(
      and(
        eq(connectors.connectorSlug, "stripe"),
        inArray(connectors.authMethod, STRIPE_OAUTH_METHOD_IDS),
        inArray(connectors.id, connectorIds),
        eq(zeroWorkflowAutomations.kind, "event"),
        eq(zeroWorkflowAutomations.eventType, "stripe-invoice-paid"),
        eq(zeroWorkflowAutomations.enabled, true),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.id))
    .for("update", { of: zeroWorkflowAutomations });
  signal.throwIfAborted();
  return rows;
}

async function recordInvoiceFanout(
  args: {
    readonly tx: StripeWorkflowTransaction;
    readonly snapshot: StripeAutomationEventSnapshot;
  },
  signal: AbortSignal,
): Promise<StripeInvoiceFanoutResult> {
  const mappedConnectors = await lockMappedStripeConnectors(
    {
      tx: args.tx,
      accountId: args.snapshot.event.connectedAccountId,
    },
    signal,
  );
  if (mappedConnectors.length === 0) {
    return {
      mappedConnectors: 0,
      candidates: 0,
      matched: 0,
      filtered: 0,
      queued: 0,
      duplicates: 0,
    };
  }
  const connectorIds = mappedConnectors.map((connector) => {
    return connector.id;
  });
  const rows = await loadStripeInvoiceFanoutCandidates(
    args.tx,
    connectorIds,
    signal,
  );

  let matched = 0;
  let filtered = 0;
  let queued = 0;
  let duplicates = 0;
  const receivedAt = nowDate();
  const billingReason = knownBillingReason(args.snapshot.invoice.billingReason);
  for (const row of rows) {
    const config = stripeInvoicePaidEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (
      !config.success ||
      config.data.connectorId !== row.connectorId ||
      config.data.stripeAccountId !== args.snapshot.event.connectedAccountId ||
      !(await stripeInvoicePaidWorkflowAutomationEnabledForOwnerInDb(
        args.tx,
        row.automation.orgId,
        row.automation.ownerUserId,
      ))
    ) {
      signal.throwIfAborted();
      continue;
    }
    signal.throwIfAborted();
    const binding = await validateStripeInvoicePaidAutomationBinding(
      {
        db: args.tx,
        eventConfig: config.data,
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
      },
      signal,
    );
    if (binding.kind !== "ok") {
      continue;
    }
    matched += 1;

    await args.tx
      .insert(stripeWorkflowAutomationHealth)
      .values({
        automationId: row.automation.id,
        lastMatchingEventReceivedAt: receivedAt,
        updatedAt: receivedAt,
      })
      .onConflictDoUpdate({
        target: stripeWorkflowAutomationHealth.automationId,
        set: {
          lastMatchingEventReceivedAt: receivedAt,
          updatedAt: receivedAt,
        },
      });
    signal.throwIfAborted();

    if (!filterMatches(config.data.billingReasons, billingReason)) {
      filtered += 1;
      continue;
    }
    const delivery = await insertStripeWorkflowDelivery(
      {
        tx: args.tx,
        candidate: row,
        snapshot: args.snapshot,
        receivedAt,
      },
      signal,
    );
    if (delivery === "duplicate") {
      duplicates += 1;
      continue;
    }
    queued += 1;
  }
  return {
    mappedConnectors: mappedConnectors.length,
    candidates: rows.length,
    matched,
    filtered,
    queued,
    duplicates,
  };
}

async function dispatchStripeDeauthorization(
  db: Db,
  event: unknown,
  signal: AbortSignal,
): Promise<DispatchStripeAutomationEventResult> {
  const supported = stripeDeauthorizedEventBaseSchema.safeParse(event);
  if (!supported.success) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "account.application.deauthorized",
      mode: eventMode(event),
      outcome: "malformed",
    });
    return { kind: "bad_request" };
  }
  if (!supported.data.livemode) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "account.application.deauthorized",
      mode: "test",
      outcome: "dropped",
    });
    return { kind: "ok", eventKind: "test", queued: 0, duplicates: 0 };
  }
  const parsed = stripeDeauthorizedEventSchema.safeParse(event);
  if (!parsed.success) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "account.application.deauthorized",
      mode: "live",
      outcome: "malformed",
    });
    return { kind: "bad_request" };
  }
  const updated = await db.transaction(async (tx) => {
    return await markStripeConnectorsDeauthorized(
      {
        tx,
        accountId: parsed.data.account,
      },
      signal,
    );
  });
  signal.throwIfAborted();
  log.debug("Processed Stripe workflow ingress", {
    eventType: "account.application.deauthorized",
    mode: "live",
    outcome: "deauthorized",
    deauthorizedConnectors: updated,
  });
  return {
    kind: "ok",
    eventKind: "deauthorized",
    queued: 0,
    duplicates: 0,
  };
}

async function dispatchStripeInvoice(
  db: Db,
  event: unknown,
  signal: AbortSignal,
): Promise<DispatchStripeAutomationEventResult> {
  const supported = stripeInvoicePaidEventBaseSchema.safeParse(event);
  if (!supported.success) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "invoice.paid",
      mode: eventMode(event),
      outcome: "malformed",
    });
    return { kind: "bad_request" };
  }
  if (!supported.data.livemode) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "invoice.paid",
      mode: "test",
      outcome: "dropped",
    });
    return { kind: "ok", eventKind: "test", queued: 0, duplicates: 0 };
  }
  const parsed = stripeInvoicePaidEventSchema.safeParse(event);
  if (!parsed.success) {
    log.debug("Processed Stripe workflow ingress", {
      eventType: "invoice.paid",
      mode: "live",
      outcome: "malformed",
    });
    return { kind: "bad_request" };
  }
  const fanout = await db.transaction(async (tx) => {
    return await recordInvoiceFanout(
      {
        tx,
        snapshot: invoiceSnapshot(parsed.data),
      },
      signal,
    );
  });
  signal.throwIfAborted();
  log.debug("Processed Stripe workflow ingress", {
    eventType: "invoice.paid",
    mode: "live",
    outcome: "accepted",
    ...fanout,
  });
  return { kind: "ok", eventKind: "invoice", ...fanout };
}

export const dispatchStripeAutomationEvent$ = command(
  async (
    { set },
    event: unknown,
    signal: AbortSignal,
  ): Promise<DispatchStripeAutomationEventResult> => {
    const eventType = stripeEventTypeSchema.safeParse(event);
    if (!eventType.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "unknown",
        mode: eventMode(event),
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    if (
      eventType.data.type !== "invoice.paid" &&
      eventType.data.type !== "account.application.deauthorized"
    ) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: eventType.data.type,
        mode: eventMode(event),
        outcome: "unsupported",
      });
      return {
        kind: "ok",
        eventKind: "ignored",
        queued: 0,
        duplicates: 0,
      };
    }

    const db = set(writeDb$);
    if (eventType.data.type === "account.application.deauthorized") {
      return await dispatchStripeDeauthorization(db, event, signal);
    }
    return await dispatchStripeInvoice(db, event, signal);
  },
);

function deliveryClaimCondition(delivery: StripeWorkflowDeliveryRow) {
  return and(
    eq(stripeWorkflowDeliveries.id, delivery.id),
    eq(stripeWorkflowDeliveries.status, "pending"),
    eq(stripeWorkflowDeliveries.revision, delivery.revision),
  );
}

async function claimDueDelivery(
  args: {
    readonly db: Db;
    readonly automationId?: string;
  },
  signal: AbortSignal,
): Promise<StripeWorkflowDeliveryRow | null> {
  const claimed = await args.db.transaction(async (tx) => {
    const currentTime = nowDate();
    const [due] = await tx
      .select()
      .from(stripeWorkflowDeliveries)
      .where(
        and(
          args.automationId === undefined
            ? undefined
            : eq(stripeWorkflowDeliveries.automationId, args.automationId),
          eq(stripeWorkflowDeliveries.status, "pending"),
          lte(stripeWorkflowDeliveries.nextAttemptAt, currentTime),
          or(
            isNull(stripeWorkflowDeliveries.claimExpiresAt),
            lte(stripeWorkflowDeliveries.claimExpiresAt, currentTime),
          ),
        ),
      )
      .orderBy(
        asc(stripeWorkflowDeliveries.nextAttemptAt),
        asc(stripeWorkflowDeliveries.id),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    signal.throwIfAborted();
    if (!due) {
      return null;
    }
    const [updatedClaim] = await tx
      .update(stripeWorkflowDeliveries)
      .set({
        attempts: due.attempts + 1,
        revision: due.revision + 1,
        claimExpiresAt: new Date(
          currentTime.getTime() + STRIPE_DELIVERY_CLAIM_MS,
        ),
        updatedAt: currentTime,
      })
      .where(deliveryClaimCondition(due))
      .returning();
    signal.throwIfAborted();
    return updatedClaim ?? null;
  });
  signal.throwIfAborted();
  return claimed;
}

async function loadDeliveryTarget(
  db: ReadonlyDb,
  delivery: StripeWorkflowDeliveryRow,
  signal: AbortSignal,
): Promise<StripeDeliveryValidation> {
  const [row] = await db
    .select({
      automation: workflowAutomationColumns(),
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      connectorId: connectors.id,
      connectorNeedsReconnect: connectors.needsReconnect,
      connectorExternalId: connectors.externalId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .leftJoin(
      connectors,
      and(
        eq(connectors.id, delivery.connectorId),
        eq(connectors.orgId, zeroWorkflowAutomations.orgId),
        eq(connectors.userId, zeroWorkflowAutomations.ownerUserId),
        eq(connectors.connectorSlug, "stripe"),
        inArray(connectors.authMethod, STRIPE_OAUTH_METHOD_IDS),
      ),
    )
    .where(eq(zeroWorkflowAutomations.id, delivery.automationId))
    .limit(1);
  signal.throwIfAborted();
  if (!row || !row.chatThreadId || !row.connectorId) {
    return { kind: "skip", reason: "automation_target_unavailable" };
  }
  const config = stripeInvoicePaidEventConfigSchema.safeParse(
    row.automation.eventConfig,
  );
  const billingReason = knownBillingReason(delivery.billingReason);
  if (
    !config.success ||
    row.automation.kind !== "event" ||
    row.automation.eventType !== "stripe-invoice-paid" ||
    !row.automation.enabled ||
    config.data.connectorId !== delivery.connectorId ||
    config.data.stripeAccountId !== delivery.stripeAccountId ||
    row.connectorExternalId !== delivery.stripeAccountId ||
    row.connectorNeedsReconnect ||
    !filterMatches(config.data.billingReasons, billingReason)
  ) {
    return { kind: "skip", reason: "automation_no_longer_matches" };
  }
  if (
    !(await stripeInvoicePaidWorkflowAutomationEnabledForOwnerInDb(
      db,
      row.automation.orgId,
      row.automation.ownerUserId,
    ))
  ) {
    signal.throwIfAborted();
    return { kind: "skip", reason: "feature_disabled" };
  }
  signal.throwIfAborted();
  const binding = await validateStripeInvoicePaidAutomationBinding(
    {
      db,
      eventConfig: config.data,
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
    },
    signal,
  );
  if (binding.kind !== "ok") {
    return { kind: "skip", reason: "connector_unavailable" };
  }
  const canFire = await workflowAutomationCanFire(
    db,
    {
      automation: row.automation,
      agentId: row.agentId,
    },
    signal,
  );
  if (!canFire) {
    return { kind: "skip", reason: "automation_access_revoked" };
  }
  return {
    kind: "ok",
    target: {
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId: row.chatThreadId,
    },
  };
}

async function updateLatestHealth(args: {
  readonly tx: StripeWorkflowTransaction;
  readonly delivery: StripeWorkflowDeliveryRow;
  readonly status: "delivered" | "skipped" | "failed";
  readonly statusAt: Date;
}): Promise<void> {
  await args.tx
    .update(stripeWorkflowAutomationHealth)
    .set({
      latestDeliveryStatus: args.status,
      latestDeliveryStatusAt: args.statusAt,
      updatedAt: args.statusAt,
    })
    .where(
      and(
        eq(
          stripeWorkflowAutomationHealth.automationId,
          args.delivery.automationId,
        ),
        eq(stripeWorkflowAutomationHealth.latestDeliveryId, args.delivery.id),
      ),
    );
}

class StripeDeliveryClaimChangedError extends Error {
  constructor() {
    super("Stripe workflow delivery claim changed");
    this.name = "StripeDeliveryClaimChangedError";
  }
}

class StripeDeliveryTargetChangedError extends Error {
  constructor(readonly reason: string) {
    super("Stripe workflow delivery target changed");
    this.name = "StripeDeliveryTargetChangedError";
  }
}

async function lockDeliveryTargetState(
  args: {
    readonly tx: WorkflowQueueAdmissionTransaction;
    readonly delivery: StripeWorkflowDeliveryRow;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.tx
    .select({ id: connectors.id })
    .from(connectors)
    .where(eq(connectors.id, args.delivery.connectorId))
    .limit(1)
    .for("update");
  signal.throwIfAborted();
  const [automation] = await args.tx
    .select({
      orgId: zeroWorkflowAutomations.orgId,
      ownerUserId: zeroWorkflowAutomations.ownerUserId,
    })
    .from(zeroWorkflowAutomations)
    .where(eq(zeroWorkflowAutomations.id, args.delivery.automationId))
    .limit(1)
    .for("update");
  signal.throwIfAborted();
  if (!automation) {
    return;
  }
  await args.tx
    .select({ userId: userFeatureSwitches.userId })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, automation.orgId),
        inArray(userFeatureSwitches.userId, [
          automation.ownerUserId,
          ORG_SENTINEL_USER_ID,
        ]),
      ),
    )
    .for("update");
  signal.throwIfAborted();
}

async function persistDeliveryAdmission(
  args: {
    readonly tx: WorkflowQueueAdmissionTransaction;
    readonly delivery: StripeWorkflowDeliveryRow;
  },
  signal: AbortSignal,
): Promise<void> {
  await lockDeliveryTargetState(args, signal);
  const validation = await loadDeliveryTarget(args.tx, args.delivery, signal);
  if (validation.kind === "skip") {
    throw new StripeDeliveryTargetChangedError(validation.reason);
  }
  const currentTime = nowDate();
  const [delivered] = await args.tx
    .update(stripeWorkflowDeliveries)
    .set({
      status: "delivered",
      claimExpiresAt: null,
      deliveredAt: currentTime,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(deliveryClaimCondition(args.delivery))
    .returning({ id: stripeWorkflowDeliveries.id });
  signal.throwIfAborted();
  if (!delivered) {
    throw new StripeDeliveryClaimChangedError();
  }
  await updateLatestHealth({
    tx: args.tx,
    delivery: args.delivery,
    status: "delivered",
    statusAt: currentTime,
  });
  signal.throwIfAborted();
}

async function finishDelivery(
  args: {
    readonly db: Db;
    readonly delivery: StripeWorkflowDeliveryRow;
    readonly status: "skipped" | "failed";
    readonly reason: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const finished = await args.db.transaction(async (tx) => {
    const currentTime = nowDate();
    const [updated] = await tx
      .update(stripeWorkflowDeliveries)
      .set({
        status: args.status,
        claimExpiresAt: null,
        lastError: args.status === "failed" ? args.reason : null,
        skipReason: args.status === "skipped" ? args.reason : null,
        skippedAt: args.status === "skipped" ? currentTime : null,
        failedAt: args.status === "failed" ? currentTime : null,
        updatedAt: currentTime,
      })
      .where(deliveryClaimCondition(args.delivery))
      .returning({ id: stripeWorkflowDeliveries.id });
    signal.throwIfAborted();
    if (!updated) {
      return false;
    }
    await updateLatestHealth({
      tx,
      delivery: args.delivery,
      status: args.status,
      statusAt: currentTime,
    });
    signal.throwIfAborted();
    return true;
  });
  signal.throwIfAborted();
  return finished;
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    STRIPE_DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    STRIPE_DELIVERY_RETRY_MAX_MS,
  );
}

function logDeliveryOutcome(args: {
  readonly delivery: StripeWorkflowDeliveryRow;
  readonly status: "pending" | "delivered" | "skipped" | "failed";
  readonly reasonCategory: string;
}): void {
  log.debug("Processed Stripe workflow delivery", {
    deliveryId: args.delivery.id,
    automationId: args.delivery.automationId,
    status: args.status,
    attempt: args.delivery.attempts,
    reasonCategory: args.reasonCategory,
  });
}

async function retryDelivery(
  args: {
    readonly db: Db;
    readonly delivery: StripeWorkflowDeliveryRow;
  },
  signal: AbortSignal,
): Promise<"retried" | "failed" | "lost"> {
  const currentTime = nowDate();
  if (
    currentTime.getTime() - args.delivery.receivedAt.getTime() >=
    STRIPE_DELIVERY_RETRY_CUTOFF_MS
  ) {
    const failed = await finishDelivery(
      {
        db: args.db,
        delivery: args.delivery,
        status: "failed",
        reason: "retry_window_exhausted",
      },
      signal,
    );
    if (failed) {
      logDeliveryOutcome({
        delivery: args.delivery,
        status: "failed",
        reasonCategory: "retry_window_exhausted",
      });
      return "failed";
    }
    return "lost";
  }
  const [updated] = await args.db
    .update(stripeWorkflowDeliveries)
    .set({
      claimExpiresAt: null,
      nextAttemptAt: new Date(
        currentTime.getTime() + retryDelayMs(args.delivery.attempts),
      ),
      lastError: "transient_delivery_error",
      revision: args.delivery.revision + 1,
      updatedAt: currentTime,
    })
    .where(deliveryClaimCondition(args.delivery))
    .returning({ id: stripeWorkflowDeliveries.id });
  signal.throwIfAborted();
  if (!updated) {
    return "lost";
  }
  logDeliveryOutcome({
    delivery: args.delivery,
    status: "pending",
    reasonCategory: "transient_delivery_error",
  });
  return "retried";
}

function deliveryContext(args: {
  readonly delivery: StripeWorkflowDeliveryRow;
  readonly target: StripeDeliveryTarget;
}) {
  return storedWorkflowAutomationContext({
    workflowName: args.target.workflowName,
    eventType: "stripe-invoice-paid",
    eventPayload: {
      automationId: args.target.automation.id,
      deliveryId: args.delivery.id,
      ...args.delivery.snapshot,
    },
  });
}

async function processClaimedDelivery(
  args: {
    readonly db: Db;
    readonly delivery: StripeWorkflowDeliveryRow;
    readonly startRun: (
      input: RunWorkflowAutomationNowArgs,
      signal: AbortSignal,
    ) => Promise<RunWorkflowAutomationResult>;
  },
  signal: AbortSignal,
): Promise<"executed" | "skipped" | "failed" | "retried" | "lost"> {
  const validation = await loadDeliveryTarget(args.db, args.delivery, signal);
  if (validation.kind === "skip") {
    const skipped = await finishDelivery(
      {
        db: args.db,
        delivery: args.delivery,
        status: "skipped",
        reason: validation.reason,
      },
      signal,
    );
    if (skipped) {
      logDeliveryOutcome({
        delivery: args.delivery,
        status: "skipped",
        reasonCategory: validation.reason,
      });
      return "skipped";
    }
    return "lost";
  }
  const target = validation.target;
  const started = await settle(
    args.startRun(
      {
        due: {
          automation: target.automation,
          agentId: target.agentId,
          chatThreadId: target.chatThreadId,
        },
        automationContext: deliveryContext({
          delivery: args.delivery,
          target,
        }),
        apiStartTime: now(),
        triggerSource: "automation-event",
        triggerBrief: `Stripe invoice paid: ${args.delivery.snapshot.invoice.id}`,
        coalescePendingScheduleRun: false,
        persistSourceTransition: async (tx) => {
          await persistDeliveryAdmission(
            {
              tx,
              delivery: args.delivery,
            },
            signal,
          );
        },
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    ),
    signal,
  );
  if (started.ok) {
    // A conflict or immediate run error is observed only after durable queue
    // admission, where persistDeliveryAdmission already marked this delivery.
    logDeliveryOutcome({
      delivery: args.delivery,
      status: "delivered",
      reasonCategory: "queue_admitted",
    });
    return "executed";
  }
  if (started.error instanceof StripeDeliveryClaimChangedError) {
    return "lost";
  }
  if (started.error instanceof StripeDeliveryTargetChangedError) {
    const skipped = await finishDelivery(
      {
        db: args.db,
        delivery: args.delivery,
        status: "skipped",
        reason: started.error.reason,
      },
      signal,
    );
    if (skipped) {
      logDeliveryOutcome({
        delivery: args.delivery,
        status: "skipped",
        reasonCategory: started.error.reason,
      });
      return "skipped";
    }
    return "lost";
  }
  return await retryDelivery(args, signal);
}

async function executeDueStripeAutomationEvents(
  args: {
    readonly db: Db;
    readonly automationId?: string;
    readonly startRun: (
      input: RunWorkflowAutomationNowArgs,
      signal: AbortSignal,
    ) => Promise<RunWorkflowAutomationResult>;
  },
  signal: AbortSignal,
): Promise<ExecuteDueStripeAutomationEventsResult> {
  const result = {
    executed: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
  };
  for (let index = 0; index < STRIPE_DELIVERY_BATCH_SIZE; index += 1) {
    const delivery = await claimDueDelivery(args, signal);
    signal.throwIfAborted();
    if (!delivery) {
      break;
    }
    const processed = await settle(
      processClaimedDelivery(
        {
          db: args.db,
          delivery,
          startRun: args.startRun,
        },
        signal,
      ),
      signal,
    );
    if (!processed.ok) {
      log.error("Stripe workflow delivery processing failed", {
        deliveryId: delivery.id,
        automationId: delivery.automationId,
        attempt: delivery.attempts,
        category: "unexpected",
      });
      const retry = await retryDelivery(
        {
          db: args.db,
          delivery,
        },
        signal,
      );
      if (retry === "retried") {
        result.retried += 1;
      } else if (retry === "failed") {
        result.failed += 1;
      }
      continue;
    }
    if (processed.value !== "lost") {
      result[processed.value] += 1;
    }
  }
  log.debug("Executed due Stripe workflow deliveries", result);
  return result;
}

export const executeDueStripeAutomationEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueStripeAutomationEventsResult> => {
    return await executeDueStripeAutomationEvents(
      {
        db: set(writeDb$),
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);

export const executeDueStripeAutomationEventsForAutomation$ = command(
  async (
    { set },
    automationId: string,
    signal: AbortSignal,
  ): Promise<ExecuteDueStripeAutomationEventsResult> => {
    return await executeDueStripeAutomationEvents(
      {
        db: set(writeDb$),
        automationId,
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);
