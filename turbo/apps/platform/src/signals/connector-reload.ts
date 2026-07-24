import { command, computed, state } from "ccstate";
import { reloadConnectors$ } from "./external/connectors.ts";
import { setAblyLoop$ } from "./realtime.ts";
import { reloadAgentConnectorAuthorizations$ } from "./zero-page/agent-connector-authorizations.ts";

const internalConnectorChangedVersion$ = state(0);

export const connectorChangedVersion$ = computed((get) => {
  return get(internalConnectorChangedVersion$);
});

export const subscribeConnectorChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    let initialRun = true;
    const onChanged$ = command(({ set }) => {
      set(reloadConnectors$);
      set(reloadAgentConnectorAuthorizations$);
      if (initialRun) {
        initialRun = false;
      } else {
        set(internalConnectorChangedVersion$, (version) => {
          return version + 1;
        });
      }
      return false;
    });
    await set(
      setAblyLoop$,
      {
        topic: "connector:changed",
        loopCommand$: onChanged$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
