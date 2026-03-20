import { state } from "ccstate";
import type { BillingTier } from "./billing.ts";

/**
 * Selected tier in the billing dialog.
 * Writable state atom — views use useGet/useSet directly.
 */
export const selectedPlanTier$ = state<BillingTier>("free");
