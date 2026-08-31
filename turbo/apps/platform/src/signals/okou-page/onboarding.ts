import { command, computed, state } from "ccstate";
import {
  onboardingStatusContract,
  onboardingStatusResponseSchema,
  type OnboardingStatusResponse,
} from "@okouai/api-contracts/contracts/onboarding";
import { apiClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import { accept } from "../../lib/accept.ts";
import {
  takeClerkBootstrapOnboardingStatus,
  type PlatformClerk,
} from "../../lib/clerk-runtime.ts";

const internalReload$ = state(0);

export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => {
    return x + 1;
  });
});

async function readClerkBootstrapOnboardingStatus(
  clerk: PlatformClerk,
): Promise<OnboardingStatusResponse | undefined> {
  const promise = takeClerkBootstrapOnboardingStatus(clerk);
  if (!promise) {
    return undefined;
  }

  const prefetched = await promise;
  const session = clerk.session;
  const user = clerk.user;
  const organization = clerk.organization;
  if (
    !prefetched ||
    prefetched.status !== 200 ||
    !session ||
    !user ||
    !organization ||
    prefetched.identity.sessionId !== session.id ||
    prefetched.identity.userId !== user.id ||
    prefetched.identity.orgId !== organization.id
  ) {
    return undefined;
  }

  const parsed = onboardingStatusResponseSchema.safeParse(prefetched.body);
  return parsed.success ? parsed.data : undefined;
}

export const onboardingStatus$ = computed(async (get) => {
  const reload = get(internalReload$);

  if (reload === 0) {
    const clerk = await get(clerk$);
    const prefetched = await readClerkBootstrapOnboardingStatus(clerk);
    if (prefetched) {
      return prefetched;
    }
  }

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
