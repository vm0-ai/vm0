import StripeSDK from "stripe";
import { env } from "../../lib/env";
import { testOverride } from "../../lib/singleton";

interface StripeInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly created: number;
  readonly amount_paid: number;
  readonly status: string | null;
  readonly hosted_invoice_url: string | null;
}

const {
  get: getMockedListInvoices,
  set: setMockedListInvoices,
  clear: clearMockedListInvoices,
} = testOverride<
  ((customerId: string) => Promise<readonly StripeInvoice[]>) | undefined
>(() => {
  return undefined;
});

export async function listStripeInvoices(
  customerId: string,
): Promise<readonly StripeInvoice[]> {
  const mocked = getMockedListInvoices();
  if (mocked) {
    return await mocked(customerId);
  }

  const stripe = new StripeSDK(env("STRIPE_SECRET_KEY"));
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

export function mockListStripeInvoices(
  fn: (customerId: string) => Promise<readonly StripeInvoice[]>,
): void {
  setMockedListInvoices(fn);
}

export function clearMockListStripeInvoices(): void {
  clearMockedListInvoices();
}

const { get: getMockedStripeClient, set: setMockedStripeClient } = testOverride<
  StripeSDK | undefined
>(() => {
  return undefined;
});

/**
 * Per-call Stripe SDK instantiation. Use this when a caller needs the
 * full SDK surface (e.g. auto-recharge invoice flow); for narrow
 * operations like list-invoices, prefer the wrapper helpers.
 *
 * In tests, override via `mockStripeClient(fakeSdk)` so the wrapper
 * doesn't construct a real Stripe client. (The centralized `vi.mock("stripe")`
 * factory in `__tests__/mocks.ts` doesn't compose with `new StripeSDK()`
 * as a constructor — vi.fn() isn't a real constructor — so we route
 * through this override instead.)
 */
export function getStripeClient(): StripeSDK {
  const mocked = getMockedStripeClient();
  if (mocked) {
    return mocked;
  }
  return new StripeSDK(env("STRIPE_SECRET_KEY"));
}

export function mockStripeClient(fakeSdk: StripeSDK): void {
  setMockedStripeClient(fakeSdk);
}
