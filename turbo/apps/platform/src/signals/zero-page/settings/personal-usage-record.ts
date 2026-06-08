import { command, computed, state } from "ccstate";
import {
  zeroUsageRecordContract,
  type UsageRecordSource,
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

// How many rows to request. "Load more" grows this and the async computed
// re-fetches from page 1 so the list stays a single contiguous, time-ordered
// record rather than juggling appended pages.
const internalPageSize$ = state(PAGE_STEP);

// Active source filter. `null` means all sources.
const sourceFilter$ = state<UsageRecordSource | null>(null);

export const usageSourceFilter$ = computed((get) => {
  return get(sourceFilter$);
});

export const setUsageSourceFilter$ = command(
  ({ set }, source: UsageRecordSource | null) => {
    set(sourceFilter$, source);
    // Reset paging so a narrower filter doesn't start mid-list.
    set(internalPageSize$, PAGE_STEP);
  },
);

export const loadMoreUsageRecord$ = command(({ get, set }) => {
  set(internalPageSize$, get(internalPageSize$) + PAGE_STEP);
});

export const usageRecordAsync$ = computed(async (get) => {
  const pageSize = get(internalPageSize$);
  const source = get(sourceFilter$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageRecordContract);
  const result = await accept(
    client.get({
      query: { page: 1, pageSize, ...(source ? { source } : {}) },
    }),
    [200],
    { toast: false },
  );
  return result.body;
});
