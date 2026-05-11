import { randomUUID } from "node:crypto";

import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function mockClerkDomains(): void {
  context.mocks.clerk.organizations.getOrganizationDomainList.mockResolvedValue(
    {
      data: [
        {
          id: "domain_test_1",
          name: "example.com",
          enrollment_mode: "automatic_invitation",
          verification: { status: "verified", strategy: "dns" },
          created_at: 1_700_000_000_000,
        },
      ],
    },
  );
}

describe("GET /api/zero/org/domains", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the domain list for an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkDomains();

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.domains).toStrictEqual([
      {
        id: "domain_test_1",
        name: "example.com",
        enrollmentMode: "automatic_invitation",
        verification: { status: "verified", strategy: "dns" },
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
    expect(
      context.mocks.clerk.organizations.getOrganizationDomainList,
    ).toHaveBeenCalledWith({ organizationId: orgId });
  });

  it("returns 403 when caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "member" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
