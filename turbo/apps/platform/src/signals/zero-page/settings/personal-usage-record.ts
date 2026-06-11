import { command, computed, state } from "ccstate";
import {
  zeroUsageRecordContract,
  type UsageRecordRange,
  type UsageRecordScope,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";

export type CreditBalanceTab = "mine" | "team";

const creditBalanceTabState$ = state<CreditBalanceTab>("mine");

export const creditBalanceTab$ = computed((get) => {
  return get(creditBalanceTabState$);
});

export const setCreditBalanceTab$ = command(
  ({ set }, tab: CreditBalanceTab) => {
    set(creditBalanceTabState$, tab);
  },
);

const PAGE_STEP = 20;

const myUsagePageSize$ = state(PAGE_STEP);
const teamUsagePageSize$ = state(PAGE_STEP);
const myUsageRangeState$ = state<UsageRecordRange>("today");
const teamUsageRangeState$ = state<UsageRecordRange>("billingPeriod");

export const myUsageRange$ = computed((get) => {
  return get(myUsageRangeState$);
});

export const teamUsageRange$ = computed((get) => {
  return get(teamUsageRangeState$);
});

export const setMyUsageRange$ = command(({ set }, range: UsageRecordRange) => {
  set(myUsageRangeState$, range);
  set(myUsagePageSize$, PAGE_STEP);
});

export const setTeamUsageRange$ = command(
  ({ set }, range: UsageRecordRange) => {
    set(teamUsageRangeState$, range);
    set(teamUsagePageSize$, PAGE_STEP);
  },
);

export const loadMoreUsageRecord$ = command(
  ({ get, set }, scope: UsageRecordScope) => {
    if (scope === "team") {
      set(teamUsagePageSize$, get(teamUsagePageSize$) + PAGE_STEP);
      return;
    }
    set(myUsagePageSize$, get(myUsagePageSize$) + PAGE_STEP);
  },
);

function currentTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export const myUsageRecordAsync$ = computed(async (get) => {
  const pageSize = get(myUsagePageSize$);
  const range = get(myUsageRangeState$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageRecordContract);
  const result = await accept(
    client.get({
      query: {
        page: 1,
        pageSize,
        scope: "mine",
        range,
        tz: currentTimeZone(),
      },
    }),
    [200],
    { toast: false },
  );
  return result.body;
});

export const teamUsageRecordAsync$ = computed(async (get) => {
  const pageSize = get(teamUsagePageSize$);
  const range = get(teamUsageRangeState$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageRecordContract);
  const result = await accept(
    client.get({
      query: {
        page: 1,
        pageSize,
        scope: "team",
        range,
        tz: currentTimeZone(),
      },
    }),
    [200],
    { toast: false },
  );
  return result.body;
});
