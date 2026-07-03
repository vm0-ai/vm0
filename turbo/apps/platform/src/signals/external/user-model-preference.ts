import { command, computed, state } from "ccstate";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroClient$ } from "../api-client.ts";
import { currentOrgInfo$ } from "../auth.ts";
import { accept } from "../../lib/accept.ts";

interface UserModelPreferenceSnapshot {
  orgId: string | null;
  response: UserModelPreferenceResponse;
}

const internalUserModelPreferenceSnapshot$ =
  state<UserModelPreferenceSnapshot | null>(null);
const internalReloadUserModelPreference$ = state(0);

export const userModelPreference$ = computed(async (get) => {
  get(internalReloadUserModelPreference$);
  const org = await get(currentOrgInfo$);
  const orgId = org?.id ?? null;
  const snapshot = get(internalUserModelPreferenceSnapshot$);
  if (snapshot?.orgId === orgId) {
    return snapshot.response;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroUserModelPreferenceContract, {
    apiBase: "api",
  });
  const result = await accept(client.get(), [200]);
  return result.body;
});

export const updateUserModelPreference$ = command(
  async (
    { get, set },
    update: UpdateUserModelPreferenceRequest,
    signal: AbortSignal,
  ): Promise<UserModelPreferenceResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserModelPreferenceContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.update({
        body: update,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    set(internalUserModelPreferenceSnapshot$, {
      orgId: org?.id ?? null,
      response: result.body,
    });
    return result.body;
  },
);

export const reloadUserModelPreference$ = command(({ get, set }) => {
  set(internalUserModelPreferenceSnapshot$, null);
  set(
    internalReloadUserModelPreference$,
    get(internalReloadUserModelPreference$) + 1,
  );
});
