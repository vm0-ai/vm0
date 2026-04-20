import { command, computed, state } from "ccstate";
import type { BillingTier } from "./billing.ts";

const internalSelectedTier$ = state<BillingTier>("free");

export const selectedPlanTier$ = computed((get) => {
  return get(internalSelectedTier$);
});

export const setSelectedPlanTier$ = command(({ set }, tier: BillingTier) => {
  set(internalSelectedTier$, tier);
});
