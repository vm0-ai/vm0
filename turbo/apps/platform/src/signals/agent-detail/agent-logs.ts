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
    const rawName = get(agentName$);
    if (!rawName) {
      return null;
    }

    // Split scoped name (e.g., "e7h4n/agent0") into name and scope
    const slashIndex = rawName.indexOf("/");
    const isOwner = slashIndex === -1;
    const name = isOwner ? rawName : rawName.slice(slashIndex + 1);
    const scope = isOwner ? undefined : rawName.slice(0, slashIndex);

    const params = new URLSearchParams({
      limit: String(limit),
      name,
    });
    if (scope) {
      params.set("scope", scope);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params;
  },
});
