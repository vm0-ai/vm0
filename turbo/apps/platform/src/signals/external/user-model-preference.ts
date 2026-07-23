import { command, computed, state } from "ccstate";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReloadUserModelPreference$ = state(0);

export const userModelPreference$ = computed(async (get) => {
  get(internalReloadUserModelPreference$);
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
    set(internalReloadUserModelPreference$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);

export const reloadUserModelPreference$ = command(({ set }) => {
  set(internalReloadUserModelPreference$, (value) => {
    return value + 1;
  });
});
