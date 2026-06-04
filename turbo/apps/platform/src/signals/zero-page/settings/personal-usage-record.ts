import { command, computed, state } from "ccstate";
import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";
import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";

const PAGE_STEP = 20;

// How many chats to request. "Load more" grows this and the async computed
// re-fetches from page 1 so the list stays a single contiguous, time-ordered
// record rather than juggling appended pages.
const internalPageSize$ = state(PAGE_STEP);

export const loadMoreUsageRecord$ = command(({ get, set }) => {
  set(internalPageSize$, get(internalPageSize$) + PAGE_STEP);
});

export const usageRecordAsync$ = computed(async (get) => {
  const pageSize = get(internalPageSize$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageRecordContract);
  const result = await accept(
    client.get({ query: { page: 1, pageSize } }),
    [200],
    { toast: false },
  );
  return result.body;
});
