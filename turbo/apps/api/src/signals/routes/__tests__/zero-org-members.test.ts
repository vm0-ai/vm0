import { randomUUID } from "node:crypto";

import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import type { OrgMember } from "@vm0/api-contracts/contracts/org-members";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

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

function clerkUserPayload(args: ClerkUserFixture): {
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

function mockClerkOrg(args: ClerkOrgFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue(args);
}

function mockClerkMemberships(rows: readonly ClerkMembershipFixture[]): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: rows.map((row) => {
        return {
          publicUserData: { userId: row.userId },
          role: row.role,
          createdAt: row.createdAtMs,
        };
      }),
    },
  );
}

function mockClerkNoInvitations(): void {
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
}

function mockClerkUsers(users: readonly ClerkUserFixture[]): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: users.map(clerkUserPayload),
  });
}

interface MembershipRequestFixture {
  readonly id: string;
  readonly userId: string;
  readonly createdAtMs: number;
}

const CLERK_MEMBERSHIP_REQUESTS_URL =
  "https://api.clerk.com/v1/organizations/:orgId/membership_requests";

function mockClerkMembershipRequests(
  expectedOrgId: string,
  requests: readonly MembershipRequestFixture[],
): { readonly callCount: () => number } {
  let calls = 0;
  server.use(
    http.get(CLERK_MEMBERSHIP_REQUESTS_URL, ({ params, request }) => {
      calls++;
      const orgId = params.orgId;
      if (orgId !== expectedOrgId) {
        return HttpResponse.json({ errors: ["wrong org"] }, { status: 500 });
      }
      const auth = request.headers.get("authorization");
      if (auth !== "Bearer sk_test_dummy_for_unit_tests") {
        return HttpResponse.json({ errors: ["bad auth"] }, { status: 401 });
      }
      return HttpResponse.json({
        data: requests.map((r) => {
          return {
            id: r.id,
            public_user_data: { user_id: r.userId },
            created_at: r.createdAtMs,
          };
        }),
      });
    }),
  );
  return {
    callCount: () => {
      return calls;
    },
  };
}

function mockClerkMembershipRequestsStatus(
  expectedOrgId: string,
  status: number,
): { readonly callCount: () => number } {
  let calls = 0;
  server.use(
    http.get(CLERK_MEMBERSHIP_REQUESTS_URL, ({ params }) => {
      calls++;
      if (params.orgId !== expectedOrgId) {
        return HttpResponse.json({ errors: ["wrong org"] }, { status: 500 });
      }
      return HttpResponse.json({ errors: ["err"] }, { status });
    }),
  );
  return {
    callCount: () => {
      return calls;
    },
  };
}

describe("GET /api/zero/org/members", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(client.members({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns members and admin-only data for an admin caller", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const requestUserId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([
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
    mockClerkNoInvitations();
    // Two getUserList calls happen (one for members, one for membership
    // requests). Both reference the same fixture set so a single mock response
    // serves both — order is an implementation detail we deliberately don't
    // assert.
    mockClerkUsers([
      {
        id: adminUserId,
        email: "admin@acme.com",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "https://img.example/ada.png",
      },
      {
        id: memberUserId,
        email: "member@acme.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
      {
        id: requestUserId,
        email: "req@x.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
    ]);
    const reqs = mockClerkMembershipRequests(orgId, [
      {
        id: "req_test_1",
        userId: requestUserId,
        createdAtMs: 1_700_000_200_000,
      },
    ]);
    mocks.clerk.session(adminUserId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.role).toBe("admin");
    expect(response.body.slug).toBe("acme");
    expect(response.body.members).toHaveLength(2);

    const admin = response.body.members.find((m: OrgMember) => {
      return m.userId === adminUserId;
    });
    expect(admin?.email).toBe("admin@acme.com");
    expect(admin?.firstName).toBe("Ada");
    expect(admin?.lastName).toBe("Lovelace");
    expect(admin?.imageUrl).toBe("https://img.example/ada.png");
    expect(admin?.role).toBe("admin");
    expect(admin?.joinedAt).toBe(new Date(1_700_000_000_000).toISOString());

    const member = response.body.members.find((m: OrgMember) => {
      return m.userId === memberUserId;
    });
    expect(member?.email).toBe("member@acme.com");
    expect(member?.firstName).toBeNull();
    expect(member?.role).toBe("member");

    expect(response.body.membershipRequests).toHaveLength(1);
    expect(response.body.membershipRequests?.[0]?.id).toBe("req_test_1");
    expect(response.body.membershipRequests?.[0]?.userId).toBe(requestUserId);
    expect(response.body.membershipRequests?.[0]?.email).toBe("req@x.com");
    expect(reqs.callCount()).toBe(1);
  });

  it("does not call membership_requests endpoint or return admin-only data for non-admin", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([]);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: "inv_admin_only",
            emailAddress: "x@y.com",
            role: "org:member",
            createdAt: 1_700_000_000_000,
          },
        ],
      },
    );
    const reqs = mockClerkMembershipRequests(orgId, [
      {
        id: "req_should_not_be_seen",
        userId: "user_xyz",
        createdAtMs: 1,
      },
    ]);
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.role).toBe("member");
    expect(response.body.pendingInvitations).toStrictEqual([]);
    expect(response.body.membershipRequests).toStrictEqual([]);
    // Critical security guarantee: the membership_requests REST endpoint
    // (admin-only) MUST NOT be called for non-admin sessions.
    expect(reqs.callCount()).toBe(0);
  });

  it("returns empty members and skips getUserList when memberships are empty", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "empty-org", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([]);
    mockClerkNoInvitations();
    mockClerkMembershipRequests(orgId, []);
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.members).toStrictEqual([]);
    expect(response.body.slug).toBe("empty-org");
    // Optimization: with no userIds we must not hit Clerk's getUserList.
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("treats Clerk membership_requests 404 as empty (feature disabled)", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    mockClerkNoInvitations();
    mockClerkUsers([
      {
        id: adminUserId,
        email: "admin@acme.com",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "",
      },
    ]);
    mockClerkMembershipRequestsStatus(orgId, 404);
    mocks.clerk.session(adminUserId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.membershipRequests).toStrictEqual([]);
    expect(response.body.members).toHaveLength(1);
  });
});
