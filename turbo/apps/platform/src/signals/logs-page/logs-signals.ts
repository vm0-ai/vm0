import { computed, command } from "ccstate";
import { createCursorPagination } from "../cursor-pagination.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Search — URL-derived, specific to the logs page
// ---------------------------------------------------------------------------

export const search$ = computed((get) => {
  return get(searchParams$).get("search") ?? "";
});

// Aliases for view backward compatibility
export const searchQueryValue$ = computed((get) => get(search$));

// ---------------------------------------------------------------------------
// Pagination — shared cursor machinery with search filter
// ---------------------------------------------------------------------------

export const {
  limit$,
  cursor$,
  data$: currentPageLogs$,
  seedCursorHistory$,
  hasPrev$: hasPrevPage$,
  currentPage$: currentPageNumber$,
  goToNextPage$,
  goToPrevPage$,
  goForwardTwoPages$,
  goBackTwoPages$,
  setRowsPerPage$,
  resetPaginationState$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const searchVal = get(search$);
    if (searchVal) {
      params.set("search", searchVal);
    }
    return params;
  },
  preserveUrlParams: (get) => {
    const searchVal = get(search$);
    const result: Record<string, string> = {};
    if (searchVal) {
      result.search = searchVal;
    }
    return result;
  },
});

// ---------------------------------------------------------------------------
// Search command — resets pagination and updates URL
// ---------------------------------------------------------------------------

export const setSearch$ = command(({ set }, search: string) => {
  set(resetPaginationState$);
  const params = new URLSearchParams();
  if (search) {
    params.set("search", search);
  }
  set(updateSearchParams$, params);
});
