import {
  createClerkReadContext,
  type ClerkOrganizationInvitation,
  type ClerkOrganizationMembership,
  type ClerkOrganizationsApi,
  type ClerkReadContext,
  type ClerkUsersApi,
} from "./clerk";

const ORGANIZATION_LIST_PAGE_SIZE = 100;

export async function listAllOrganizationMemberships(
  organizations: Pick<ClerkOrganizationsApi, "getOrganizationMembershipList">,
  organizationId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<ClerkOrganizationMembership[]> {
  const memberships: ClerkOrganizationMembership[] = [];
  for (let offset = 0; ; offset += ORGANIZATION_LIST_PAGE_SIZE) {
    signal.throwIfAborted();
    const page = await organizations.getOrganizationMembershipList(
      {
        organizationId,
        limit: ORGANIZATION_LIST_PAGE_SIZE,
        offset,
      },
      context,
      signal,
    );
    signal.throwIfAborted();
    memberships.push(...page.data);
    if (page.data.length < ORGANIZATION_LIST_PAGE_SIZE) {
      return memberships;
    }
  }
}

export async function listAllUserOrganizationMemberships(
  users: Pick<ClerkUsersApi, "getOrganizationMembershipList">,
  userId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<ClerkOrganizationMembership[]> {
  const memberships: ClerkOrganizationMembership[] = [];
  for (let offset = 0; ; offset += ORGANIZATION_LIST_PAGE_SIZE) {
    signal.throwIfAborted();
    const page = await users.getOrganizationMembershipList(
      {
        userId,
        limit: ORGANIZATION_LIST_PAGE_SIZE,
        offset,
      },
      context,
      signal,
    );
    signal.throwIfAborted();
    memberships.push(...page.data);
    if (page.data.length < ORGANIZATION_LIST_PAGE_SIZE) {
      return memberships;
    }
  }
}

export async function listAllPendingOrganizationInvitations(
  organizations: Pick<ClerkOrganizationsApi, "getOrganizationInvitationList">,
  organizationId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<ClerkOrganizationInvitation[]> {
  const invitations: ClerkOrganizationInvitation[] = [];
  for (let offset = 0; ; offset += ORGANIZATION_LIST_PAGE_SIZE) {
    signal.throwIfAborted();
    const page = await organizations.getOrganizationInvitationList(
      {
        organizationId,
        status: ["pending"],
        limit: ORGANIZATION_LIST_PAGE_SIZE,
        offset,
      },
      context,
      signal,
    );
    signal.throwIfAborted();
    invitations.push(...page.data);
    if (page.data.length < ORGANIZATION_LIST_PAGE_SIZE) {
      return invitations;
    }
  }
}
