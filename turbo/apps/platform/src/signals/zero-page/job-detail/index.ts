import { command } from "ccstate";

import { setZeroJobAgentName$, resetActiveTab$ } from "./agent-name.ts";
import { fetchZeroJobDetail$, resetDetailState$ } from "./detail.ts";
import {
  fetchZeroJobInstructions$,
  resetInstructionsState$,
} from "./instructions.ts";
import { resetSavingState$ } from "./settings.ts";
import {
  fetchZeroJobUserConnectors$,
  resetConnectorsState$,
} from "./connectors.ts";
import { fetchZeroJobSchedule$, resetScheduleState$ } from "./schedule.ts";
import {
  fetchZeroJobFirewallPolicies$,
  resetFirewallState$,
} from "./firewall.ts";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { zeroJobActiveTab$, setZeroJobActiveTab$ } from "./agent-name.ts";

export {
  zeroJobDetail$,
  zeroJobDetailLoading$,
  zeroJobDetailError$,
} from "./detail.ts";

export {
  zeroJobInstructions$,
  zeroJobInstructionsLoading$,
  zeroJobInstructionsError$,
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  setZeroJobEditedContent$,
  discardZeroJobEdit$,
  zeroJobBuilding$,
  zeroJobBuildError$,
  buildZeroJobInstructions$,
} from "./instructions.ts";

export { zeroJobSettingsSaving$, zeroJobUpdateSettings$ } from "./settings.ts";

export {
  zeroJobConnectorsLoading$,
  zeroJobAddedConnectors$,
  zeroJobConnectorsDirty$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  discardZeroJobConnectors$,
  saveZeroJobConnectors$,
} from "./connectors.ts";

export {
  zeroJobScheduleEntries$,
  zeroJobScheduleLoading$,
  zeroJobScheduleError$,
  saveZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  deleteZeroJobSchedule$,
} from "./schedule.ts";
export type { ZeroJobScheduleSaveParams } from "./schedule.ts";

export {
  zeroJobFirewallPolicies$,
  setZeroJobFirewallPolicies$,
} from "./firewall.ts";

export { deleteZeroJobAgent$ } from "./delete.ts";

// ---------------------------------------------------------------------------
// Combined fetch — loads detail, then instructions + schedule in parallel
// (Temporary orchestrator — will be removed when async computed signals
// replace the imperative fetch pattern.)
// ---------------------------------------------------------------------------

export const fetchZeroJobData$ = command(
  async ({ set }, agentName: string, signal: AbortSignal) => {
    // Reset all state so the skeleton screen shows while loading new data
    set(resetDetailState$);
    set(resetInstructionsState$);
    set(resetScheduleState$);
    set(resetConnectorsState$);
    set(resetSavingState$);
    set(resetActiveTab$);
    set(resetFirewallState$);

    set(setZeroJobAgentName$, agentName);
    await set(fetchZeroJobDetail$, signal);
    await Promise.all([
      set(fetchZeroJobInstructions$, signal),
      set(fetchZeroJobSchedule$, signal),
      set(fetchZeroJobFirewallPolicies$, signal),
      set(fetchZeroJobUserConnectors$, signal),
    ]);
  },
);
