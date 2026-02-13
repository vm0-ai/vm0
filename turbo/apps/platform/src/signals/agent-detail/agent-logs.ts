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
    const agentName = get(agentName$);
    if (!agentName) {
      return null;
    }

    const params = new URLSearchParams({
      limit: String(limit),
      agent: agentName,
    });
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params;
  },
});
