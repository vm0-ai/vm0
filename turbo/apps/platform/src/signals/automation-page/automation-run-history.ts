/**
 * Signals for automation run history — paginated list of runs
 * triggered by a specific automation.
 */
import { command, computed, state } from "ccstate";
import { createCursorPagination } from "../cursor-pagination.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// Automation ID — set by the detail page setup
// ---------------------------------------------------------------------------

const internalAutomationId$ = state<string | null>(null);

const runHistoryAutomationId$ = computed((get) => {
  return get(internalAutomationId$);
});

/** Set the automation ID to fetch run history for. */
export const setRunHistoryAutomationId$ = command(
  ({ set }, id: string | null) => {
    set(internalAutomationId$, id);
  },
);

// ---------------------------------------------------------------------------
// Status filter — URL-derived
// ---------------------------------------------------------------------------

/** Status filter derived from URL `?runStatus=` query param. */
export const automationRunStatusFilter$ = computed((get) => {
  return get(searchParams$).get("runStatus") ?? "all";
});

// ---------------------------------------------------------------------------
// Cursor pagination instance
// ---------------------------------------------------------------------------

export const {
  limit$: automationRunLimit$,
  data$: automationRunData$,
  seedCursorHistory$: seedAutomationRunCursorHistory$,
  hasPrev$: automationRunHasPrev$,
  currentPage$: automationRunCurrentPage$,
  goToNextPage$: goToNextAutomationRunPage$,
  goToPrevPage$: goToPrevAutomationRunPage$,
  goForwardTwoPages$: goForwardTwoAutomationRunPages$,
  goBackTwoPages$: goBackTwoAutomationRunPages$,
  setRowsPerPage$: setAutomationRunRowsPerPage$,
  resetPaginationState$: resetAutomationRunPagination$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const scheduleId = get(runHistoryAutomationId$);
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

    const statusFilter = get(automationRunStatusFilter$);
    if (statusFilter !== "all") {
      params.set("status", statusFilter);
    }

    return params;
  },
  preserveUrlParams: (get) => {
    const result: Record<string, string> = {};
    const status = get(automationRunStatusFilter$);
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
export const automationRunAvailableStatuses$ = computed(async (get) => {
  const response = await get(automationRunData$);
  return response.filters.statuses;
});

// ---------------------------------------------------------------------------
// Filter update command
// ---------------------------------------------------------------------------

/** Update the status filter — resets pagination and writes to URL. */
export const setAutomationRunStatusFilter$ = command(
  ({ set }, value: string) => {
    set(resetAutomationRunPagination$);
    const params = new URLSearchParams();

    if (value !== "all") {
      params.set("runStatus", value);
    }

    set(updateSearchParams$, params);
  },
);
