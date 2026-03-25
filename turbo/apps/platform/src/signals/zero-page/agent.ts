import { computed } from "ccstate";
import { pathParams$ } from "../route";
import { defaultAgentId$ } from "./zero-agent-name";
import { zeroClient$ } from "../api-client";
import { zeroAgentsByIdContract } from "@vm0/core";

export const currentAgentId$ = computed((get) => {
  const params = get(pathParams$) as { id?: string } | undefined;
  return params?.id ?? null;
});

export const isDefaultAgent$ = computed(async (get) => {
  return get(currentAgentId$) === (await get(defaultAgentId$));
});

export const currentAgent$ = computed(async (get) => {
  const agentId = get(currentAgentId$);
  if (!agentId) {
    return null;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroAgentsByIdContract);

  const resp = await client.get({ params: { id: agentId } });

  return resp.status === 200 ? resp.body : null;
});

export const currentAgentDisplayName$ = computed(async (get) => {
  const agent = await get(currentAgent$);
  return agent?.displayName;
});
