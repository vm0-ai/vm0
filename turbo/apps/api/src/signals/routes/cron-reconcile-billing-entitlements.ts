import { cronReconcileBillingEntitlementsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { reconcileBillingEntitlements$ } from "../services/cron-billing-entitlements.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const reconcileBillingEntitlementsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!hasValidCronSecret(get)) {
      return cronUnauthorized();
    }

    const result = await set(reconcileBillingEntitlements$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronReconcileBillingEntitlementsRoutes: readonly RouteEntry[] = [
  {
    route: cronReconcileBillingEntitlementsContract.reconcile,
    handler: reconcileBillingEntitlementsRoute$,
  },
];
