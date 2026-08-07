import type { createClerkClient } from "@clerk/backend";

type ClerkClient = ReturnType<typeof createClerkClient>;
type ClerkOrganizations = ClerkClient["organizations"];
type OrganizationMembership = Awaited<
  ReturnType<ClerkOrganizations["getOrganizationMembershipList"]>
>["data"][number];
type OrganizationInvitation = Awaited<
  ReturnType<ClerkOrganizations["getOrganizationInvitationList"]>
>["data"][number];

const ORGANIZATION_LIST_PAGE_SIZE = 100;

export async function listAllOrganizationMemberships(
  organizations: Pick<ClerkOrganizations, "getOrganizationMembershipList">,
  organizationId: string,
): Promise<OrganizationMembership[]> {
  const memberships: OrganizationMembership[] = [];
  for (let offset = 0; ; offset += ORGANIZATION_LIST_PAGE_SIZE) {
    const page = await organizations.getOrganizationMembershipList({
      organizationId,
      limit: ORGANIZATION_LIST_PAGE_SIZE,
      offset,
    });
    memberships.push(...page.data);
    if (page.data.length < ORGANIZATION_LIST_PAGE_SIZE) {
      return memberships;
    }
  }
}

export async function listAllPendingOrganizationInvitations(
  organizations: Pick<ClerkOrganizations, "getOrganizationInvitationList">,
  organizationId: string,
): Promise<OrganizationInvitation[]> {
  const invitations: OrganizationInvitation[] = [];
  for (let offset = 0; ; offset += ORGANIZATION_LIST_PAGE_SIZE) {
    const page = await organizations.getOrganizationInvitationList({
      organizationId,
      status: ["pending"],
      limit: ORGANIZATION_LIST_PAGE_SIZE,
      offset,
    });
    invitations.push(...page.data);
    if (page.data.length < ORGANIZATION_LIST_PAGE_SIZE) {
      return invitations;
    }
  }
}
