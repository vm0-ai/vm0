import { computed } from "ccstate";
import {
  agentsList$,
  schedules$,
  agentsMissingItems$,
  agentsLoading$,
  agentsError$,
  fetchAgentsList$,
  getAgentScheduleStatus,
} from "../agents-page/agents-list.ts";

export {
  schedules$,
  agentsMissingItems$,
  agentsLoading$,
  agentsError$,
  fetchAgentsList$,
  getAgentScheduleStatus,
};

/**
 * Non-default agents for display in the Zero team page.
 * Filters out the default agent from the full agents list.
 */
export const zeroSubagents$ = computed(async (get) => {
  const agents = await get(agentsList$);
  return agents.filter((a) => !a.isDefault);
});
