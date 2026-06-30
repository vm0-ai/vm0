import { command, state } from "ccstate";

import { getApiTestMocks } from "../../../../__tests__/mocks";

interface SeedOrgMembershipValues {
  readonly orgId: string;
  readonly userId: string;
  readonly slug?: string;
  readonly name?: string;
  readonly role?: "admin" | "member";
}

interface OrgMembershipFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface MockMembership {
  readonly orgId: string;
  readonly userId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: "admin" | "member";
}

const orgMemberships$ = state<readonly MockMembership[]>([]);

function clerkRole(role: "admin" | "member"): "org:admin" | "org:member" {
  return role === "admin" ? "org:admin" : "org:member";
}

function clerkMembership(membership: MockMembership) {
  return {
    role: clerkRole(membership.role),
    organization: {
      id: membership.orgId,
      slug: membership.slug,
      name: membership.name,
    },
    publicUserData: { userId: membership.userId },
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  };
}

function installMembershipMocks(memberships: readonly MockMembership[]): void {
  const mocks = getApiTestMocks();
  mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const userId =
        typeof args === "object" &&
        args !== null &&
        "userId" in args &&
        typeof args.userId === "string"
          ? args.userId
          : "";
      return Promise.resolve({
        data: memberships
          .filter((membership) => {
            return membership.userId === userId;
          })
          .map(clerkMembership),
      });
    },
  );
  mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const organizationId =
        typeof args === "object" &&
        args !== null &&
        "organizationId" in args &&
        typeof args.organizationId === "string"
          ? args.organizationId
          : "";
      return Promise.resolve({
        data: memberships
          .filter((membership) => {
            return membership.orgId === organizationId;
          })
          .map(clerkMembership),
      });
    },
  );
  mocks.clerk.organizations.getOrganization.mockImplementation(
    (args: unknown) => {
      const organizationId =
        typeof args === "object" &&
        args !== null &&
        "organizationId" in args &&
        typeof args.organizationId === "string"
          ? args.organizationId
          : "";
      const membership = memberships.find((candidate) => {
        return candidate.orgId === organizationId;
      });
      return Promise.resolve({
        id: organizationId,
        slug: membership?.slug ?? `org-${organizationId.slice(-8)}`,
        name: membership?.name ?? "",
        createdBy: membership?.userId ?? null,
      });
    },
  );
}

export const seedOrgMembership$ = command(
  (
    { get, set },
    values: SeedOrgMembershipValues,
    signal: AbortSignal,
  ): OrgMembershipFixture => {
    const membership: MockMembership = {
      orgId: values.orgId,
      userId: values.userId,
      slug: values.slug ?? `org-${values.orgId.slice(-8)}`,
      name: values.name ?? "",
      role: values.role ?? "member",
    };
    const memberships = [
      ...get(orgMemberships$).filter((candidate) => {
        return (
          candidate.orgId !== values.orgId || candidate.userId !== values.userId
        );
      }),
      membership,
    ];
    set(orgMemberships$, memberships);
    installMembershipMocks(memberships);
    signal.throwIfAborted();
    return { orgId: values.orgId, userId: values.userId };
  },
);
