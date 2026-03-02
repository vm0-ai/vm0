import { command } from "ccstate";
import { createElement } from "react";
import { AgentLogDetailPage } from "../../views/agent-detail-page/agent-log-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { fetchAgentDetail$ } from "./agent-detail.ts";
import { setLogDetailSearchTerm$ } from "../logs-page/log-detail-state.ts";
import { setupEventPolling$ } from "../logs-page/log-detail-signals.ts";

export const setupAgentLogDetailPage$ = command(
  ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentLogDetailPage));

    detach(set(fetchAgentDetail$), Reason.Daemon);

    set(setLogDetailSearchTerm$, "");

    detach(set(setupEventPolling$, signal), Reason.Daemon);
  },
);
