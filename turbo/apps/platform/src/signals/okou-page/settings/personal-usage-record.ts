import { command, computed, state } from "ccstate";
import {
  usageRecordContract,
  type UsageRecordRange,
  type UsageRecordResponse,
} from "@okouai/api-contracts/contracts/usage-record";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { onRejection, resetSignal } from "../../utils.ts";

export type CreditBalanceTab = "mine" | "team";

const creditBalanceTabState$ = state<CreditBalanceTab>("mine");
const usagePackMembersDialogOpenState$ = state(false);
const usagePackMemberAdditionsExpandedMemberIdState$ = state<string | null>(
  null,
);
const resetUsagePackMembersDialogSignal$ = resetSignal();

export const creditBalanceTab$ = computed((get) => {
  return get(creditBalanceTabState$);
});

export const setCreditBalanceTab$ = command(
  ({ set }, tab: CreditBalanceTab) => {
    set(creditBalanceTabState$, tab);
  },
);

export const usagePackMembersDialogOpen$ = computed((get) => {
  return get(usagePackMembersDialogOpenState$);
});

export const usagePackMemberAdditionsExpandedMemberId$ = computed((get) => {
  return get(usagePackMemberAdditionsExpandedMemberIdState$);
});

const resetUsagePackMembersDialogState$ = command(({ set }) => {
  set(usagePackMembersDialogOpenState$, false);
  set(usagePackMemberAdditionsExpandedMemberIdState$, null);
});

export const openUsagePackMembersDialog$ = command(
  ({ set }, settingsDialogSignal: AbortSignal) => {
    settingsDialogSignal.throwIfAborted();
    const signal = set(
      resetUsagePackMembersDialogSignal$,
      settingsDialogSignal,
    );
    signal.addEventListener(
      "abort",
      () => {
        set(resetUsagePackMembersDialogState$);
      },
      { once: true },
    );
    set(usagePackMemberAdditionsExpandedMemberIdState$, null);
    set(usagePackMembersDialogOpenState$, true);
  },
);

export const closeUsagePackMembersDialog$ = command(({ set }) => {
  set(usagePackMembersDialogOpenState$, false);
});

export const completeUsagePackMembersDialogClose$ = command(({ get, set }) => {
  if (get(usagePackMembersDialogOpenState$)) {
    return;
  }
  set(resetUsagePackMembersDialogSignal$);
});

export const toggleUsagePackMemberAdditions$ = command(
  ({ get, set }, memberId: string) => {
    const expandedMemberId = get(
      usagePackMemberAdditionsExpandedMemberIdState$,
    );
    set(
      usagePackMemberAdditionsExpandedMemberIdState$,
      expandedMemberId === memberId ? null : memberId,
    );
  },
);

const PAGE_SIZE = 20;

type LoadUsageRecordPage = (
  page: number,
  signal?: AbortSignal,
) => Promise<UsageRecordResponse>;

const usageRecordReload$ = state(0);
const myUsageRecordPages$ = state<readonly UsageRecordResponse[]>([]);
const myUsageRecordRequestedPages$ = state<ReadonlySet<number>>(new Set());
const myUsageRecordGeneration$ = state(0);
const myUsageRangeState$ = state<UsageRecordRange>("today");
const teamUsageRangeState$ = state<UsageRecordRange>("billingPeriod");

const resetMyUsageRecordPages$ = command(({ set }) => {
  set(myUsageRecordPages$, []);
  set(myUsageRecordRequestedPages$, new Set());
  set(myUsageRecordGeneration$, (generation) => {
    return generation + 1;
  });
});

const releaseMyUsageRecordPageRequest$ = command(
  ({ get, set }, page: number, generation: number) => {
    if (get(myUsageRecordGeneration$) !== generation) {
      return;
    }
    set(myUsageRecordRequestedPages$, (pages) => {
      const retryablePages = new Set(pages);
      retryablePages.delete(page);
      return retryablePages;
    });
  },
);

export const myUsageRange$ = computed((get) => {
  return get(myUsageRangeState$);
});

export const teamUsageRange$ = computed((get) => {
  return get(teamUsageRangeState$);
});

export const setMyUsageRange$ = command(({ set }, range: UsageRecordRange) => {
  set(myUsageRangeState$, range);
  set(resetMyUsageRecordPages$);
});

export const setTeamUsageRange$ = command(
  ({ set }, range: UsageRecordRange) => {
    set(teamUsageRangeState$, range);
  },
);

const loadMyUsageRecordPage$ = computed((get): LoadUsageRecordPage => {
  const range = get(myUsageRangeState$);
  const client = get(apiClient$)(usageRecordContract);
  return async (page, signal) => {
    const result = await accept(
      client.get({
        query: {
          page,
          pageSize: PAGE_SIZE,
          scope: "mine",
          range,
          tz: currentTimeZone(),
        },
        ...(signal ? { fetchOptions: { signal } } : {}),
      }),
      [200],
      signal,
    );
    return result.body;
  };
});

function currentTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const firstMyUsageRecordPage$ = computed(
  (get): Promise<UsageRecordResponse> => {
    get(usageRecordReload$);
    return get(loadMyUsageRecordPage$)(1);
  },
);

export const myUsageRecordAsync$ = computed(async (get) => {
  const firstPage = await get(firstMyUsageRecordPage$);
  const appendedPages = get(myUsageRecordPages$);
  const latestPage = appendedPages.at(-1) ?? firstPage;
  return {
    ...latestPage,
    rows: [
      ...firstPage.rows,
      ...appendedPages.flatMap((page) => {
        return page.rows;
      }),
    ],
  };
});

export const loadMoreUsageRecord$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const generation = get(myUsageRecordGeneration$);
    const loaded = await get(myUsageRecordAsync$);
    signal.throwIfAborted();
    if (
      get(myUsageRecordGeneration$) !== generation ||
      loaded.rows.length >= loaded.pagination.total
    ) {
      return;
    }

    const nextPage = get(myUsageRecordPages$).length + 2;
    if (get(myUsageRecordRequestedPages$).has(nextPage)) {
      return;
    }
    set(myUsageRecordRequestedPages$, (pages) => {
      return new Set([...pages, nextPage]);
    });

    const loadPage = get(loadMyUsageRecordPage$);
    const next = await onRejection(loadPage(nextPage, signal), () => {
      set(releaseMyUsageRecordPageRequest$, nextPage, generation);
    });
    if (signal.aborted) {
      set(releaseMyUsageRecordPageRequest$, nextPage, generation);
      return;
    }
    if (get(myUsageRecordGeneration$) !== generation) {
      return;
    }
    set(myUsageRecordPages$, (pages) => {
      return [...pages, next];
    });
  },
);

export const reloadUsageRecords$ = command(({ set }) => {
  set(resetMyUsageRecordPages$);
  set(usageRecordReload$, (value) => {
    return value + 1;
  });
});

export const teamMemberUsageAsync$ = computed(async (get) => {
  get(usageRecordReload$);
  const range = get(teamUsageRangeState$);
  const createClient = get(apiClient$);
  const client = createClient(usageMembersContract);
  const result = await accept(
    client.get({
      query: {
        range,
        tz: currentTimeZone(),
      },
    }),
    [200],
  );
  return result.body;
});
