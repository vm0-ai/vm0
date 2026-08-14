import type { StripeClient, StripeInvoice } from "../external/stripe-client";
import { settle } from "../utils";

type BillingOperationInvoiceResult =
  | { readonly status: "completed"; readonly hostedInvoiceUrl: null }
  | {
      readonly status: "pending_payment";
      readonly hostedInvoiceUrl: string;
    };

async function finalizeOperationInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  operationId: string,
  signal: AbortSignal,
): Promise<StripeInvoice> {
  if (invoice.status !== "draft") {
    return invoice;
  }
  const finalized = await stripe.invoices.finalizeInvoice(
    invoice.id,
    {},
    { idempotencyKey: `billing-operation:${operationId}:finalize` },
  );
  signal.throwIfAborted();
  return finalized;
}

export async function completeBillingOperationInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice | null,
  operationId: string,
  signal: AbortSignal,
  options?: { readonly payOpenInvoice?: boolean },
): Promise<BillingOperationInvoiceResult> {
  if (!invoice) {
    return { status: "completed", hostedInvoiceUrl: null };
  }

  const shouldPay = invoice.status === "draft" || options?.payOpenInvoice;
  let current = await finalizeOperationInvoice(
    stripe,
    invoice,
    operationId,
    signal,
  );
  if (shouldPay && current.status === "open") {
    const payment = await settle(
      stripe.invoices.pay(
        current.id,
        {},
        { idempotencyKey: `billing-operation:${operationId}:pay` },
      ),
      signal,
    );
    current = payment.ok
      ? payment.value
      : await stripe.invoices.retrieve(current.id);
    signal.throwIfAborted();
  }

  if (current.status === "paid") {
    return { status: "completed", hostedInvoiceUrl: null };
  }
  if (current.status === "open" && current.hosted_invoice_url) {
    return {
      status: "pending_payment",
      hostedInvoiceUrl: current.hosted_invoice_url,
    };
  }
  throw new Error(
    `Stripe operation invoice ${current.id} is ${current.status ?? "missing a status"} without a hosted payment URL`,
  );
}
