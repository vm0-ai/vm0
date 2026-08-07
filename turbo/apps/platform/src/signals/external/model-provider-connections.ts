import { command, computed, state } from "ccstate";
import {
  zeroModelProviderConnectionsByIdContract,
  zeroModelProviderConnectionsMainContract,
  type CreateModelProviderConnectionRequest,
  type UpdateModelProviderConnectionRequest,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { refreshOrgModelPolicies$ } from "./org-model-policies.ts";

const reloadModelProviderConnections$ = state(0);

export const modelProviderConnections$ = computed(async (get) => {
  get(reloadModelProviderConnections$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelProviderConnectionsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body.connections;
});

export const createModelProviderConnection$ = command(
  async (
    { get, set },
    input: CreateModelProviderConnectionRequest,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProviderConnectionsMainContract);
    const result = await accept(
      client.create({ body: input, fetchOptions: { signal } }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadModelProviderConnections$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);

export const updateModelProviderConnection$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly input: UpdateModelProviderConnectionRequest;
    },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProviderConnectionsByIdContract);
    const result = await accept(
      client.update({
        params: { id: args.id },
        body: args.input,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadModelProviderConnections$, (value) => {
      return value + 1;
    });
    await set(refreshOrgModelPolicies$, signal);
    signal.throwIfAborted();
    return result.body;
  },
);

export const deleteModelProviderConnection$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProviderConnectionsByIdContract);
    await accept(
      client.delete({ params: { id }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadModelProviderConnections$, (value) => {
      return value + 1;
    });
    await set(refreshOrgModelPolicies$, signal);
    signal.throwIfAborted();
  },
);
