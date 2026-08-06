import { command, computed, state } from "ccstate";

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;
export const PAY_AS_YOU_GO = "payAsYouGo" as const;

export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];
export type MemberUsageSelection = UsagePackUsd | typeof PAY_AS_YOU_GO;

const internalMemberUsageSelections$ = state<
  Readonly<Record<string, MemberUsageSelection>>
>({});

export const memberUsageSelections$ = computed((get) => {
  return get(internalMemberUsageSelections$);
});

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

export const addMemberUsageConfiguration$ = command(
  ({ set }, memberId: string) => {
    set(
      internalMemberUsageSelections$,
      (current): Readonly<Record<string, MemberUsageSelection>> => {
        return { ...current, [memberId]: 20 };
      },
    );
  },
);

export const removeMemberUsageConfiguration$ = command(
  ({ set }, memberId: string) => {
    set(internalMemberUsageSelections$, (current) => {
      const next = { ...current };
      delete next[memberId];
      return next;
    });
  },
);
