import { command, computed, state } from "ccstate";
import {
  type UsagePackMigrationPreviewResponse,
  USAGE_PACKS_USD,
  type UsagePackManagementResponse,
  type UsagePackSubscriptionChangePreviewResponse,
  type UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";

import { onRef } from "../../utils.ts";

export const MINIMUM_USAGE_PACK_USD = USAGE_PACKS_USD[0];

export type { UsagePackUsd };
export type UsagePackPlanTier = "pro" | "team";
export type MemberUsageSelection = UsagePackUsd;

type ManagedUsagePackAllocation =
  UsagePackManagementResponse["allocations"][number];

export function managedUsagePackSelection(
  allocation: ManagedUsagePackAllocation,
): UsagePackUsd {
  const pendingChange = allocation.pendingChange;
  return pendingChange?.kind === "downgrade" &&
    pendingChange.status === "scheduled" &&
    pendingChange.targetUsagePackUsd !== null
    ? pendingChange.targetUsagePackUsd
    : allocation.usagePackUsd;
}

const internalSelectedUsagePackPlan$ = state<UsagePackPlanTier | null>(null);

const internalMemberUsageSelections$ = state<
  Readonly<Record<string, MemberUsageSelection>>
>({});
const internalUsagePackSubscriptionChangePreview$ =
  state<UsagePackSubscriptionChangePreviewResponse | null>(null);
const internalUsagePackMigrationPreview$ =
  state<UsagePackMigrationPreviewResponse | null>(null);

export const memberUsageSelections$ = computed((get) => {
  return get(internalMemberUsageSelections$);
});

export const selectedUsagePackPlan$ = computed((get) => {
  return get(internalSelectedUsagePackPlan$);
});

export const usagePackSubscriptionChangePreview$ = computed((get) => {
  return get(internalUsagePackSubscriptionChangePreview$);
});

export const usagePackMigrationPreview$ = computed((get) => {
  return get(internalUsagePackMigrationPreview$);
});

export const setSelectedUsagePackPlan$ = command(
  ({ set }, plan: UsagePackPlanTier | null) => {
    set(internalSelectedUsagePackPlan$, plan);
  },
);

export const setUsagePackMigrationPreview$ = command(
  ({ set }, preview: UsagePackMigrationPreviewResponse | null) => {
    set(internalUsagePackMigrationPreview$, preview);
  },
);

export const closeUsagePackMigrationPreview$ = command(({ set }) => {
  set(internalUsagePackMigrationPreview$, null);
});

export const resetUsagePackPricing$ = command(({ set }) => {
  set(internalSelectedUsagePackPlan$, null);
  set(internalMemberUsageSelections$, {});
  set(internalUsagePackSubscriptionChangePreview$, null);
  set(internalUsagePackMigrationPreview$, null);
});

export const setUsagePackSubscriptionChangePreview$ = command(
  ({ set }, preview: UsagePackSubscriptionChangePreviewResponse | null) => {
    set(internalUsagePackSubscriptionChangePreview$, preview);
  },
);

export const usagePackPricingPageRef$ = onRef(
  command((_context, element: HTMLDivElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    element.focus();
  }),
);

export const setMemberUsageSelection$ = command(
  (
    { set },
    selection: {
      readonly memberId: string;
      readonly usage: MemberUsageSelection;
    },
  ) => {
    set(internalMemberUsageSelections$, (current) => {
      return { ...current, [selection.memberId]: selection.usage };
    });
  },
);

export const setMemberUsageSelections$ = command(
  ({ set }, selections: Readonly<Record<string, MemberUsageSelection>>) => {
    set(internalMemberUsageSelections$, selections);
  },
);
