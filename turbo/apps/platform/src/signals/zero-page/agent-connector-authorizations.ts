import { command, computed, state } from "ccstate";

const internalAgentConnectorAuthorizationsReload$ = state(0);

export const agentConnectorAuthorizationsReload$ = computed((get) => {
  return get(internalAgentConnectorAuthorizationsReload$);
});

export const reloadAgentConnectorAuthorizations$ = command(({ set }) => {
  set(internalAgentConnectorAuthorizationsReload$, (x) => {
    return x + 1;
  });
});
