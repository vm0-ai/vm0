export interface StripeWorkflowEventSnapshotMetadata {
  readonly [key: string]: string;
}

export interface StripeWorkflowEventSnapshotLinePrice {
  readonly id: string | null;
  readonly productId: string | null;
  readonly currency: string | null;
  readonly unitAmount: number | null;
  readonly recurringInterval: string | null;
}

export interface StripeWorkflowEventSnapshotLinePricing {
  readonly type: string | null;
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly unitAmountDecimal: string | null;
}

export interface StripeWorkflowEventSnapshotLine {
  readonly id: string | null;
  readonly type: string | null;
  readonly description: string | null;
  readonly quantity: number | null;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly metadata: StripeWorkflowEventSnapshotMetadata;
  readonly period: {
    readonly start: string | null;
    readonly end: string | null;
  } | null;
  readonly price: StripeWorkflowEventSnapshotLinePrice | null;
  readonly pricing: StripeWorkflowEventSnapshotLinePricing | null;
}

export interface StripeWorkflowEventSnapshot {
  readonly event: {
    readonly id: string;
    readonly type: "invoice.paid";
    readonly createdAt: string;
    readonly connectedAccountId: string;
    readonly livemode: true;
  };
  readonly invoice: {
    readonly id: string;
    readonly status: string | null;
    readonly billingReason: string | null;
    readonly amountPaid: number | null;
    readonly amountDue: number | null;
    readonly currency: string | null;
    readonly collectionMethod: string | null;
    readonly hostedInvoiceUrl: string | null;
    readonly invoicePdf: string | null;
    readonly metadata: StripeWorkflowEventSnapshotMetadata;
    readonly lines: {
      readonly data: readonly StripeWorkflowEventSnapshotLine[];
      readonly hasMore: boolean;
      readonly totalCount: number | null;
    };
  };
  readonly customer: {
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  } | null;
  readonly relationships: {
    readonly subscriptionId: string | null;
    readonly paymentIntentId: string | null;
    readonly paymentIds: readonly string[];
    readonly paymentIntentIds: readonly string[];
    readonly chargeIds: readonly string[];
    readonly paymentRecordIds: readonly string[];
  };
}
