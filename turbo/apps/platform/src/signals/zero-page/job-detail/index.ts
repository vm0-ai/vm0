import { command } from "ccstate";

import { setZeroJobAgentName$, resetActiveTab$ } from "./agent-name.ts";
import { discardZeroJobEdit$ } from "./instructions.ts";
import { discardZeroJobConnectors$ } from "./connectors.ts";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { zeroJobActiveTab$, setZeroJobActiveTab$ } from "./agent-name.ts";

export { zeroJobDetail$, reloadJobDetail$ } from "./detail.ts";

export {
  zeroJobInstructions$,
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  setZeroJobEditedContent$,
  discardZeroJobEdit$,
  buildZeroJobInstructions$,
} from "./instructions.ts";

export { zeroJobUpdateSettings$ } from "./settings.ts";

export {
  zeroJobAddedConnectors$,
  zeroJobConnectorsDirty$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  discardZeroJobConnectors$,
  saveZeroJobConnectors$,
} from "./connectors.ts";

export {
  zeroJobScheduleEntries$,
  saveZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  deleteZeroJobSchedule$,
} from "./schedule.ts";
export type { ZeroJobScheduleSaveParams } from "./schedule.ts";

export {
  zeroJobPermissionPolicies$,
  zeroJobAllowUnknownEndpoints$,
} from "./permissions.ts";

export { deleteZeroJobAgent$ } from "./delete.ts";

// ---------------------------------------------------------------------------
// Set active agent — sets the agent name and resets draft states.
// All async data (detail, instructions, schedule, connectors, permissions) will
// re-evaluate reactively through the async computed dependency chain.
// ---------------------------------------------------------------------------

export const setActiveAgent$ = command(({ set }, agentName: string) => {
  set(setZeroJobAgentName$, agentName);
  set(resetActiveTab$);
  set(discardZeroJobEdit$);
  set(discardZeroJobConnectors$);
});
