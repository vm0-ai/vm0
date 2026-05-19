import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import type {
  OrgModelPoliciesResponse,
  UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { currentOrgInfo$ } from "../auth.ts";

const internalReloadOrgModelPolicies$ = state(0);

interface OrgModelPoliciesSnapshot {
  orgId: string | null;
  response: OrgModelPoliciesResponse;
}

const internalOrgModelPoliciesSnapshot$ =
  state<OrgModelPoliciesSnapshot | null>(null);

interface UpdateOrgModelPoliciesParams {
  policies: UpdateOrgModelPolicy[];
  toast?: boolean;
}

export const orgModelPolicies$ = computed(async (get) => {
  get(internalReloadOrgModelPolicies$);
  const org = await get(currentOrgInfo$);
  const orgId = org?.id ?? null;
  const snapshot = get(internalOrgModelPoliciesSnapshot$);
  if (snapshot?.orgId === orgId) {
    return snapshot.response;
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelPoliciesMainContract, {
    apiBase: "api",
  });
  const result = await accept(client.list(), [200]);
  return result.body;
});

export const refreshOrgModelPolicies$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalOrgModelPoliciesSnapshot$, null);
    set(internalReloadOrgModelPolicies$, (value) => {
      return value + 1;
    });
    const response = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    set(internalOrgModelPoliciesSnapshot$, {
      orgId: org?.id ?? null,
      response,
    });
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
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    set(internalOrgModelPoliciesSnapshot$, {
      orgId: org?.id ?? null,
      response: result.body,
    });
    if (params.toast !== false) {
      toast.success("Model provider settings updated");
    }
    return result.body;
  },
);
