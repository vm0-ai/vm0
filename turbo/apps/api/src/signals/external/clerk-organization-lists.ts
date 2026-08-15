import type {
  ClerkOrganizationInvitation,
  ClerkOrganizationMembership,
  ClerkOrganizationsApi,
} from "./clerk";

const ORGANIZATION_LIST_PAGE_SIZE = 100;

export async function listAllOrganizationMemberships(
  organizations: Pick<ClerkOrganizationsApi, "getOrganizationMembershipList">,
  organizationId: string,
): Promise<ClerkOrganizationMembership[]> {
  const memberships: ClerkOrganizationMembership[] = [];
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
  organizations: Pick<ClerkOrganizationsApi, "getOrganizationInvitationList">,
  organizationId: string,
): Promise<ClerkOrganizationInvitation[]> {
  const invitations: ClerkOrganizationInvitation[] = [];
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
