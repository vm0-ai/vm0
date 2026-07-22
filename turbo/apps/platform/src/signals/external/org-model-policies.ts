import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import type { UpdateOrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReloadOrgModelPolicies$ = state(0);

interface UpdateOrgModelPoliciesParams {
  policies: UpdateOrgModelPolicy[];
  toast?: boolean;
}

export const orgModelPolicies$ = computed(async (get) => {
  get(internalReloadOrgModelPolicies$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelPoliciesMainContract, {
    apiBase: "api",
  });
  const result = await accept(client.list(), [200]);
  return result.body;
});

export const refreshOrgModelPolicies$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalReloadOrgModelPolicies$, (value) => {
      return value + 1;
    });
    const response = await get(orgModelPolicies$);
    signal.throwIfAborted();
    return response;
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { get, set },
    params: UpdateOrgModelPoliciesParams,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelPoliciesMainContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.update({
        body: { policies: params.policies },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReloadOrgModelPolicies$, (value) => {
      return value + 1;
    });
    if (params.toast !== false) {
      toast.success("Model provider settings updated");
    }
    return result.body;
  },
);
