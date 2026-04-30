import StripeSDK from "stripe";
import { env } from "../../lib/env";

interface StripeInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly created: number;
  readonly amount_paid: number;
  readonly status: string | null;
  readonly hosted_invoice_url: string | null;
}

export async function listStripeInvoices(
  customerId: string,
): Promise<readonly StripeInvoice[]> {
  const secretKey = env("STRIPE_SECRET_KEY");
  if (!secretKey) {
    return [];
  }

  const stripe = new StripeSDK(secretKey);
  const result = await stripe.invoices.list({
    customer: customerId,
    limit: 24,
  });

  return result.data.map((inv) => {
    return {
      id: inv.id,
      number: inv.number ?? null,
      created: inv.created,
      amount_paid: inv.amount_paid,
      status: inv.status ?? null,
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
    };
  });
}
