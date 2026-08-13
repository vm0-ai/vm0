import { command, computed, state } from "ccstate";
import {
  type UserPreferenceChangedPayload,
  userPreferenceChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/realtime";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  zeroUserModelPreferenceContract,
} from "@okouai/api-contracts/contracts/zero-user-model-preference";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";

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

export const reloadUserModelPreference$ = command(({ set }) => {
  set(internalReloadUserModelPreference$, (value) => {
    return value + 1;
  });
});

export const updateUserModelPreference$ = command(
  async (
    { get },
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
    // Cross-device/default-model writes are reflected via the
    // `userPreferenceChanged` realtime topic; do not reload the local cache
    // here (the initiating session receives the push like any other).
    return result.body;
  },
);

function payloadRequestsKindsReloadFor(
  payload: unknown,
  kinds: UserPreferenceChangedPayload["kinds"],
): boolean {
  const parsed = userPreferenceChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return false;
  }
  return parsed.data.kinds.some((kind) => {
    return kinds.includes(kind);
  });
}

const reloadUserModelPreferenceFromRealtime$ = command(({ set }) => {
  set(reloadUserModelPreference$);
  return false;
});

const handleUserPreferenceChanged$ = command(
  ({ set }, payload: unknown): boolean => {
    if (
      payloadRequestsKindsReloadFor(payload, [
        "defaultModel",
        "defaultVideoModel",
      ])
    ) {
      set(reloadUserModelPreference$);
    }
    return false;
  },
);

export const setupUserPreferenceRealtime$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyPayloadLoop$,
      {
        topic: "userPreferenceChanged",
        loopCommand$: handleUserPreferenceChanged$,
        catchUpCommand$: reloadUserModelPreferenceFromRealtime$,
      },
      signal,
    );
  },
);
