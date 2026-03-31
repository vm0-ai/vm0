/**
 * Signals for schedule run history — paginated list of runs
 * triggered by a specific schedule.
 */
import { command, computed, state } from "ccstate";
import { createCursorPagination } from "../cursor-pagination.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Schedule ID — set by the detail page setup
// ---------------------------------------------------------------------------

const internalScheduleId$ = state<string | null>(null);

const scheduleRunHistoryScheduleId$ = computed((get) => {
  return get(internalScheduleId$);
});

/** Set the schedule ID to fetch run history for. */
export const setScheduleRunHistoryScheduleId$ = command(
  ({ set }, id: string | null) => {
    set(internalScheduleId$, id);
  },
);

// ---------------------------------------------------------------------------
// Status filter — URL-derived
// ---------------------------------------------------------------------------

/** Status filter derived from URL `?runStatus=` query param. */
export const scheduleRunStatusFilter$ = computed((get) => {
  return get(searchParams$).get("runStatus") ?? "all";
});

// ---------------------------------------------------------------------------
// Cursor pagination instance
// ---------------------------------------------------------------------------

export const {
  limit$: scheduleRunLimit$,
  data$: scheduleRunData$,
  seedCursorHistory$: seedScheduleRunCursorHistory$,
  hasPrev$: scheduleRunHasPrev$,
  currentPage$: scheduleRunCurrentPage$,
  goToNextPage$: goToNextScheduleRunPage$,
  goToPrevPage$: goToPrevScheduleRunPage$,
  goForwardTwoPages$: goForwardTwoScheduleRunPages$,
  goBackTwoPages$: goBackTwoScheduleRunPages$,
  setRowsPerPage$: setScheduleRunRowsPerPage$,
  resetPaginationState$: resetScheduleRunPagination$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const scheduleId = get(scheduleRunHistoryScheduleId$);
    if (!scheduleId) {
      return null;
    }

    const params = new URLSearchParams({
      limit: String(limit),
      scheduleId,
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const statusFilter = get(scheduleRunStatusFilter$);
    if (statusFilter !== "all") {
      params.set("status", statusFilter);
    }

    return params;
  },
  preserveUrlParams: (get) => {
    const result: Record<string, string> = {};
    const status = get(scheduleRunStatusFilter$);
    if (status !== "all") {
      result.runStatus = status;
    }
    return result;
  },
});

// ---------------------------------------------------------------------------
// Available statuses from the server response
// ---------------------------------------------------------------------------

/** Available status values from the server (only statuses present in run history). */
export const scheduleRunAvailableStatuses$ = computed(async (get) => {
  const response = await get(scheduleRunData$);
  return response.filters.statuses;
});

// ---------------------------------------------------------------------------
// Filter update command
// ---------------------------------------------------------------------------

/** Update the status filter — resets pagination and writes to URL. */
export const setScheduleRunStatusFilter$ = command(({ set }, value: string) => {
  set(resetScheduleRunPagination$);
  const params = new URLSearchParams();

  if (value !== "all") {
    params.set("runStatus", value);
  }

  set(updateSearchParams$, params);
});
