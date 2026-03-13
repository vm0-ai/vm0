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

    // Split qualified name (e.g., "e7h4n/agent0") into name and org
    const slashIndex = rawName.indexOf("/");
    const isOwner = slashIndex === -1;
    const name = isOwner ? rawName : rawName.slice(slashIndex + 1);
    const org = isOwner ? undefined : rawName.slice(0, slashIndex);

    const params = new URLSearchParams({
      limit: String(limit),
      name,
    });
    if (org) {
      params.set("scope", org);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params;
  },
});
