import { command, computed, state } from "ccstate";
import type { BillingTier } from "./billing.ts";

const internalSelectedTier$ = state<BillingTier>("free");

export const selectedPlanTier$ = computed((get) => get(internalSelectedTier$));

export const setSelectedPlanTier$ = command(({ set }, tier: BillingTier) => {
  set(internalSelectedTier$, tier);
});
