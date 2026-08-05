import { command, computed, state } from "ccstate";

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;

export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];
export type UsagePackPlanTier = "pro" | "team";

const internalUsagePackSelection$ = state<
  Readonly<Record<UsagePackPlanTier, UsagePackUsd>>
>({
  pro: 20,
  team: 20,
});

export const usagePackSelection$ = computed((get) => {
  return get(internalUsagePackSelection$);
});

export const setUsagePackSelection$ = command(
  (
    { set },
    selection: {
      readonly plan: UsagePackPlanTier;
      readonly pack: UsagePackUsd;
    },
  ) => {
    set(internalUsagePackSelection$, (current) => {
      return { ...current, [selection.plan]: selection.pack };
    });
  },
);
