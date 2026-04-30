import { computed, type Computed } from "ccstate";

import { createClerkClient } from "@clerk/backend";
import { singleton } from "../../lib/singleton";
import { env } from "../../lib/env";

const clerk = singleton((): ReturnType<typeof createClerkClient> => {
  return createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
});

export const clerk$ = computed(() => {
  return clerk();
});

export type OrganizationMembershipList = Awaited<
  ReturnType<ReturnType<typeof clerk>["users"]["getOrganizationMembershipList"]>
>;

export function membershipsByUserId(
  userId: string,
  limit = 100,
): Computed<Promise<OrganizationMembershipList>> {
  return computed((get) => {
    return get(clerk$).users.getOrganizationMembershipList({
      userId,
      limit,
    });
  });
}
