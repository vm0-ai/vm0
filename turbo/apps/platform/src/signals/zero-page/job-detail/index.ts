import { command } from "ccstate";

import { setAgentName$, resetActiveTab$ } from "./agent-name.ts";
import { discardAgentEdit$ } from "./instructions.ts";
import { discardAgentConnectorsDraft$ } from "./connectors.ts";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { agentActiveTab$, setAgentActiveTab$ } from "./agent-name.ts";

export { agentDetail$ } from "./detail.ts";

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
  authorizeAgentConnector$,
  deauthorizeAgentConnector$,
  saveAgentConnectors$,
} from "./connectors.ts";

export { deleteAgent$ } from "./delete.ts";

// ---------------------------------------------------------------------------
// Set active agent — sets the agent name and resets draft states. Async detail,
// instructions, connectors, and permissions re-evaluate through the computed
// dependency chain.
// ---------------------------------------------------------------------------

export const setActiveAgent$ = command(({ set }, agentName: string) => {
  set(setAgentName$, agentName);
  set(resetActiveTab$);
  set(discardAgentEdit$);
  set(discardAgentConnectorsDraft$);
});
