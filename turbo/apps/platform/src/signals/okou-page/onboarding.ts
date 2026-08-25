import { command, computed, state } from "ccstate";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);

export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => {
    return x + 1;
  });
});

export const onboardingStatus$ = computed(async (get) => {
  get(internalReload$);

  const client = get(apiClient$)(onboardingStatusContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

/**
 * Whether the current user needs onboarding. Onboarding is purely admin
 * workspace setup — the backend derives this from admin status and the
 * persisted onboarding completion marker.
 */
export const needsOnboarding$ = computed(async (get) => {
  const status = await get(onboardingStatus$);
  return status.needsOnboarding;
});
