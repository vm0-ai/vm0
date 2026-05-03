import { command } from "ccstate";

import { setAgentName$, resetActiveTab$ } from "./agent-name.ts";
import { discardAgentEdit$ } from "./instructions.ts";
import { discardAgentConnectorsDraft$ } from "./connectors.ts";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { agentActiveTab$, setAgentActiveTab$ } from "./agent-name.ts";

export { agentDetail$, reloadAgentDetail$ } from "./detail.ts";

export {
  agentInstructions$,
  agentEditedContent$,
  agentInstructionsDirty$,
  setAgentEditedContent$,
  discardAgentEdit$,
  buildAgentInstructions$,
} from "./instructions.ts";

export { updateAgentSettings$ } from "./settings.ts";

export {
  agentAuthorizedConnectors$,
  agentConnectorsDirty$,
  authorizeAgentConnector$,
  deauthorizeAgentConnector$,
  discardAgentConnectorsDraft$,
  saveAgentConnectors$,
} from "./connectors.ts";

export {
  agentScheduleEntries$,
  saveAgentSchedule$,
  toggleAgentScheduleEnabled$,
  deleteAgentSchedule$,
} from "./schedule.ts";
export type { AgentScheduleSaveParams } from "./schedule.ts";

export { agentPermissionPolicies$ } from "./permissions.ts";

export { deleteAgent$ } from "./delete.ts";

// ---------------------------------------------------------------------------
// Set active agent — sets the agent name and resets draft states.
// All async data (detail, instructions, schedule, connectors, permissions) will
// re-evaluate reactively through the async computed dependency chain.
// ---------------------------------------------------------------------------

export const setActiveAgent$ = command(({ set }, agentName: string) => {
  set(setAgentName$, agentName);
  set(resetActiveTab$);
  set(discardAgentEdit$);
  set(discardAgentConnectorsDraft$);
});
