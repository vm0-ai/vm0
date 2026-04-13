/**
 * Signals for the cross-schedule run history list — every run the current
 * user has that was triggered by any schedule (in the active org).
 *
 * Powers the "Run History" tab on `/schedules` (sibling of the Schedules tab).
 * Shares URL state (`runStatus`, `cursor`, `limit`) with the regular pagination
 * machinery via `createCursorPagination`.
 */
import { command, computed } from "ccstate";
import { createCursorPagination } from "../cursor-pagination.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import type { LogStatus } from "../zero-page/log-types.ts";

// ---------------------------------------------------------------------------
// Status filter — URL-derived
// ---------------------------------------------------------------------------

/** Status filter derived from URL `?runStatus=` query param. */
export const allScheduleRunStatusFilter$ = computed((get) => {
  return get(searchParams$).get("runStatus") ?? "all";
});

// ---------------------------------------------------------------------------
// Cursor pagination instance
// ---------------------------------------------------------------------------

export const {
  limit$: allScheduleRunLimit$,
  data$: allScheduleRunData$,
  seedCursorHistory$: seedAllScheduleRunCursorHistory$,
  hasPrev$: allScheduleRunHasPrev$,
  currentPage$: allScheduleRunCurrentPage$,
  goToNextPage$: goToNextAllScheduleRunPage$,
  goToPrevPage$: goToPrevAllScheduleRunPage$,
  goForwardTwoPages$: goForwardTwoAllScheduleRunPages$,
  goBackTwoPages$: goBackTwoAllScheduleRunPages$,
  setRowsPerPage$: setAllScheduleRunRowsPerPage$,
  resetPaginationState$: resetAllScheduleRunPagination$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const params = new URLSearchParams({
      limit: String(limit),
      // Fixed filter — this list is defined as "every schedule-triggered run"
      triggerSource: "schedule",
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const statusFilter = get(allScheduleRunStatusFilter$);
    if (statusFilter !== "all") {
      params.set("status", statusFilter);
    }

    return params;
  },
  preserveUrlParams: (get) => {
    const result: Record<string, string> = {};
    const status = get(allScheduleRunStatusFilter$);
    if (status !== "all") {
      result.runStatus = status;
    }
    const tab = get(searchParams$).get("tab");
    if (tab) {
      result.tab = tab;
    }
    return result;
  },
});

// ---------------------------------------------------------------------------
// Available statuses from the server response
// ---------------------------------------------------------------------------

/** Available status values from the server response (for the filter dropdown). */
export const allScheduleRunAvailableStatuses$ = computed(
  async (get): Promise<LogStatus[]> => {
    const response = await get(allScheduleRunData$);
    return response.filters.statuses;
  },
);

// ---------------------------------------------------------------------------
// Filter update command
// ---------------------------------------------------------------------------

/** Update the status filter — resets pagination and writes to URL. */
export const setAllScheduleRunStatusFilter$ = command(
  ({ get, set }, value: string) => {
    set(resetAllScheduleRunPagination$);
    const params = new URLSearchParams();

    if (value !== "all") {
      params.set("runStatus", value);
    }

    // Preserve the active tab so switching status doesn't fall back to the
    // default (schedules) tab on `/schedules`.
    const tab = get(searchParams$).get("tab");
    if (tab) {
      params.set("tab", tab);
    }

    set(updateSearchParams$, params);
  },
);
