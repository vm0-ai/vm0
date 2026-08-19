import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  billingStatusContract,
  billingCreditCheckoutContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";

import { getClientConfig, handleError } from "../core/client-factory";

export async function getBillingStatus(): Promise<BillingStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(billingStatusContract, config);

  const result = await client.get({ headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get billing status");
}

export async function createCreditCheckout(body: {
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly autoRecharge?: {
    readonly enabled: boolean;
    readonly threshold?: number;
    readonly amount?: number;
  };
}): Promise<{ readonly url: string }> {
  const config = await getClientConfig();
  const client = initClient(billingCreditCheckoutContract, config);

  const result = await client.create({ body });
  if (result.status === 200) {
    if ("url" in result.body) {
      return result.body;
    }
    throw new Error("Credit checkout unexpectedly returned a preview");
  }
  handleError(result, "Failed to create credit checkout");
}
