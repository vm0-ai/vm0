import { command, computed, state } from "ccstate";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import type { UpdateOrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReloadOrgModelPolicies$ = state(0);

export const orgModelPolicies$ = computed(async (get) => {
  get(internalReloadOrgModelPolicies$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelPoliciesMainContract, {
    apiBase: "api",
  });
  const result = await accept(client.list(), [200]);
  return result.body;
});

export const updateOrgModelPolicies$ = command(
  async (
    { get, set },
    policies: UpdateOrgModelPolicy[],
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelPoliciesMainContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.update({
        body: { policies },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReloadOrgModelPolicies$, (x) => {
      return x + 1;
    });
    return result.body;
  },
);
