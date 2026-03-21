import { command, computed, state } from "ccstate";
import type { BillingTier } from "./billing.ts";

const internalSelectedTier$ = state<BillingTier>("free");

export const selectedPlanTier$ = computed((get) => get(internalSelectedTier$));

export const setSelectedPlanTier$ = command(({ set }, tier: BillingTier) => {
  set(internalSelectedTier$, tier);
});

// ---------------------------------------------------------------------------
// Auto-recharge form state
// ---------------------------------------------------------------------------

const internalAutoRechargeEnabled$ = state(false);
const internalAutoRechargeThreshold$ = state("");
const internalAutoRechargeAmount$ = state("");

export const autoRechargeEnabled$ = computed((get) =>
  get(internalAutoRechargeEnabled$),
);
export const autoRechargeThreshold$ = computed((get) =>
  get(internalAutoRechargeThreshold$),
);
export const autoRechargeAmount$ = computed((get) =>
  get(internalAutoRechargeAmount$),
);

export const setAutoRechargeEnabled$ = command(({ set }, enabled: boolean) => {
  set(internalAutoRechargeEnabled$, enabled);
});

export const setAutoRechargeThreshold$ = command(
  ({ set }, threshold: string) => {
    set(internalAutoRechargeThreshold$, threshold);
  },
);

export const setAutoRechargeAmount$ = command(({ set }, amount: string) => {
  set(internalAutoRechargeAmount$, amount);
});

export const syncAutoRechargeForm$ = command(
  (
    { set },
    config: {
      enabled: boolean;
      threshold: number | null;
      amount: number | null;
    },
  ) => {
    set(internalAutoRechargeEnabled$, config.enabled);
    set(internalAutoRechargeThreshold$, config.threshold?.toString() ?? "");
    set(internalAutoRechargeAmount$, config.amount?.toString() ?? "");
  },
);
