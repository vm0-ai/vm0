import { initClient } from "@ts-rest/core";
import {
  zeroBillingStatusContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingAutoRechargeContract,
  type BillingStatusResponse,
  type AutoRechargeConfig,
} from "@vm0/api-contracts/contracts/zero-billing";

import { getClientConfig, handleError } from "../core/client-factory";

export async function getZeroBillingStatus(): Promise<BillingStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroBillingStatusContract, config);

  const result = await client.get({ headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get billing status");
}

export async function updateZeroBillingAutoRecharge(body: {
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}): Promise<AutoRechargeConfig> {
  const config = await getClientConfig();
  const client = initClient(zeroBillingAutoRechargeContract, config);

  const result = await client.update({ body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to update auto-recharge");
}

export async function createZeroCreditCheckout(body: {
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
  const client = initClient(zeroBillingCreditCheckoutContract, config);

  const result = await client.create({ body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to create credit checkout");
}
