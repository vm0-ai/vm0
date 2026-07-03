import { command, computed, state } from "ccstate";
import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);

export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => {
    return x + 1;
  });
});

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);

  const client = get(zeroClient$)(onboardingStatusContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

/**
 * Whether the current user needs onboarding. Onboarding is purely admin
 * workspace setup — the backend derives this from admin status and the
 * persisted onboarding completion marker.
 */
export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding;
});
