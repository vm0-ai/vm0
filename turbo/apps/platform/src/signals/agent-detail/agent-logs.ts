import { createCursorPagination } from "../cursor-pagination.ts";
import { agentName$ } from "./agent-detail.ts";

// ---------------------------------------------------------------------------
// Pagination — shared cursor machinery with agent filter
// ---------------------------------------------------------------------------

export const {
  limit$: agentLogsLimit$,
  data$: currentAgentLogs$,
  seedCursorHistory$: seedAgentLogsCursorHistory$,
  hasPrev$: agentLogsHasPrev$,
  currentPage$: agentLogsCurrentPage$,
  goToNextPage$: goToNextAgentLogsPage$,
  goToPrevPage$: goToPrevAgentLogsPage$,
  goForwardTwoPages$: goForwardTwoAgentLogsPages$,
  goBackTwoPages$: goBackTwoAgentLogsPages$,
  setRowsPerPage$: setAgentLogsRowsPerPage$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const name = get(agentName$);
    if (!name) {
      return null;
    }

    const params = new URLSearchParams({
      limit: String(limit),
      name,
    });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params;
  },
});
