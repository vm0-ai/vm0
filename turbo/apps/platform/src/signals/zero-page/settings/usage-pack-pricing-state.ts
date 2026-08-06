import { command, computed, state } from "ccstate";

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;
export const MINIMUM_USAGE_PACK_USD = USAGE_PACKS_USD[0];
export const PAY_AS_YOU_GO = "payAsYouGo" as const;

export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];
export type UsagePackPlanTier = "pro" | "team";
export type MemberUsageSelection = UsagePackUsd | typeof PAY_AS_YOU_GO;

const internalSelectedUsagePackPlan$ = state<UsagePackPlanTier | null>(null);

const internalMemberUsageSelections$ = state<
  Readonly<Record<string, MemberUsageSelection>>
>({});

export const memberUsageSelections$ = computed((get) => {
  return get(internalMemberUsageSelections$);
});

export const selectedUsagePackPlan$ = computed((get) => {
  return get(internalSelectedUsagePackPlan$);
});

export const setSelectedUsagePackPlan$ = command(
  ({ set }, plan: UsagePackPlanTier | null) => {
    set(internalSelectedUsagePackPlan$, plan);
  },
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
