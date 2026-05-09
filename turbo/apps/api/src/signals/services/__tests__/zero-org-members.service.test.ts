import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { getApiTestMocks, resetApiTestMocks } from "../../../__tests__/mocks";
import { zeroOrgMembersList } from "../zero-org-data.service";

const store = createStore();
const mocks = getApiTestMocks();

interface ClerkOrgFixture {
  readonly slug: string;
  readonly createdAt: number;
}

interface ClerkMembershipFixture {
  readonly userId: string;
  readonly role: "org:admin" | "org:member";
  readonly createdAtMs: number;
}

interface ClerkUserFixture {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

function clerkUser(args: ClerkUserFixture): {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
} {
  return {
    id: args.id,
    emailAddresses: [{ id: `email-${args.id}`, emailAddress: args.email }],
    primaryEmailAddressId: `email-${args.id}`,
    firstName: args.firstName,
    lastName: args.lastName,
    imageUrl: args.imageUrl,
  };
}

function mockOrg(args: ClerkOrgFixture): void {
  mocks.clerk.organizations.getOrganization.mockResolvedValue(args);
}

function mockMemberships(rows: readonly ClerkMembershipFixture[]): void {
  mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue({
    data: rows.map((row) => {
      return {
        publicUserData: { userId: row.userId },
        role: row.role,
        createdAt: row.createdAtMs,
      };
    }),
  });
}

function mockNoInvitations(): void {
  mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue({
    data: [],
  });
}

describe("zeroOrgMembersList", () => {
  beforeEach(() => {
    resetApiTestMocks();
  });

  it("returns members list with populated profile data for an admin caller", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;

    mockOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
      {
        userId: memberUserId,
        role: "org:member",
        createdAtMs: 1_700_000_100_000,
      },
    ]);
    mockNoInvitations();
    mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        clerkUser({
          id: adminUserId,
          email: "admin@acme.com",
          firstName: "Ada",
          lastName: "Lovelace",
          imageUrl: "https://img.example/ada.png",
        }),
        clerkUser({
          id: memberUserId,
          email: "member@acme.com",
          firstName: null,
          lastName: null,
          imageUrl: "",
        }),
      ],
    });
    mocks.clerk.fetchMembershipRequests.mockResolvedValue([]);

    const result = await store.get(
      zeroOrgMembersList({
        orgId,
        userId: adminUserId,
        callerRole: "admin",
      }),
    );

    expect(result.role).toBe("admin");
    expect(result.slug).toBe("acme");
    expect(result.members).toHaveLength(2);

    const admin = result.members.find((m) => {
      return m.userId === adminUserId;
    });
    expect(admin?.email).toBe("admin@acme.com");
    expect(admin?.firstName).toBe("Ada");
    expect(admin?.lastName).toBe("Lovelace");
    expect(admin?.role).toBe("admin");

    const member = result.members.find((m) => {
      return m.userId === memberUserId;
    });
    expect(member?.email).toBe("member@acme.com");
    expect(member?.firstName).toBeNull();
    expect(member?.role).toBe("member");
  });

  it("includes membershipRequests when admin and pending requests exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const requestUserId = `user_${randomUUID()}`;

    mockOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    mockNoInvitations();
    mocks.clerk.users.getUserList
      .mockResolvedValueOnce({
        data: [
          clerkUser({
            id: adminUserId,
            email: "admin@acme.com",
            firstName: "Ada",
            lastName: "Lovelace",
            imageUrl: "",
          }),
        ],
      })
      .mockResolvedValueOnce({
        data: [
          clerkUser({
            id: requestUserId,
            email: "req@x.com",
            firstName: null,
            lastName: null,
            imageUrl: "",
          }),
        ],
      });
    mocks.clerk.fetchMembershipRequests.mockResolvedValue([
      {
        id: "req_test_1",
        public_user_data: { user_id: requestUserId },
        created_at: 1_700_000_200_000,
      },
    ]);

    const result = await store.get(
      zeroOrgMembersList({
        orgId,
        userId: adminUserId,
        callerRole: "admin",
      }),
    );

    expect(result.membershipRequests).toHaveLength(1);
    expect(result.membershipRequests?.[0]?.id).toBe("req_test_1");
    expect(result.membershipRequests?.[0]?.userId).toBe(requestUserId);
    expect(result.membershipRequests?.[0]?.email).toBe("req@x.com");
  });

  it("returns the callerRole verbatim in the response role field", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockMemberships([]);
    mockNoInvitations();
    mocks.clerk.fetchMembershipRequests.mockResolvedValue([]);

    const adminResult = await store.get(
      zeroOrgMembersList({ orgId, userId, callerRole: "admin" }),
    );
    expect(adminResult.role).toBe("admin");

    const memberResult = await store.get(
      zeroOrgMembersList({ orgId, userId, callerRole: "member" }),
    );
    expect(memberResult.role).toBe("member");
  });

  it("returns empty pendingInvitations and membershipRequests for non-admin members", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockMemberships([]);
    mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue({
      data: [
        {
          id: "inv_admin_only",
          emailAddress: "x@y.com",
          role: "org:member",
          createdAt: 1_700_000_000_000,
        },
      ],
    });

    const result = await store.get(
      zeroOrgMembersList({ orgId, userId, callerRole: "member" }),
    );

    expect(result.role).toBe("member");
    expect(result.pendingInvitations).toStrictEqual([]);
    expect(result.membershipRequests).toStrictEqual([]);
    // Critical: fetchMembershipRequests MUST NOT be called for non-admin
    // (avoids unnecessary Clerk REST API call + leaks the admin-only data).
    expect(mocks.clerk.fetchMembershipRequests).not.toHaveBeenCalled();
  });

  it("handles empty memberships list gracefully", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockOrg({ slug: "empty-org", createdAt: 1_700_000_000_000 });
    mockMemberships([]);
    mockNoInvitations();
    mocks.clerk.fetchMembershipRequests.mockResolvedValue([]);

    const result = await store.get(
      zeroOrgMembersList({ orgId, userId, callerRole: "admin" }),
    );

    expect(result.members).toStrictEqual([]);
    expect(result.slug).toBe("empty-org");
    // Optimization: no userIds → no getUserList call.
    expect(mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });
});
