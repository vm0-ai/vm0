import { computed, type Computed } from "ccstate";

import { clerk } from "../../lib/clerk";

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
