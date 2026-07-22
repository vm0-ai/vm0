import { command } from "ccstate";
import { reloadConnectors$ } from "./external/connectors.ts";
import { setAblyLoop$ } from "./realtime.ts";
import { reloadAgentConnectorAuthorizations$ } from "./zero-page/agent-connector-authorizations.ts";

export const subscribeConnectorChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadConnectors$);
      set(reloadAgentConnectorAuthorizations$);
      return false;
    });
    await set(
      setAblyLoop$,
      { topic: "connector:changed", loopCommand$: onChanged$ },
      signal,
    );
  },
);
