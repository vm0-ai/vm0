import { randomUUID } from "node:crypto";

import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { createApp } from "../../../app-factory";
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

describe("POST /api/zero/org/domains", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("adds a domain for an admin", async () => {
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

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.add({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "example.com",
          enrollmentMode: "manual_invitation",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: "Domain example.com added",
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationDomain,
    ).toHaveBeenCalledWith({
      organizationId: orgId,
      name: "example.com",
      enrollmentMode: "manual_invitation",
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.add({
        headers: {},
        body: {
          name: "example.com",
          enrollmentMode: "manual_invitation",
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(
      context.mocks.clerk.organizations.createOrganizationDomain,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.add({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "example.com",
          enrollmentMode: "manual_invitation",
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(
      context.mocks.clerk.organizations.createOrganizationDomain,
    ).not.toHaveBeenCalled();
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
      client.add({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "example.com",
          enrollmentMode: "manual_invitation",
        },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Access denied",
      code: "FORBIDDEN",
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationDomain,
    ).not.toHaveBeenCalled();
  });

  it("rejects invalid enrollment modes before calling Clerk", async () => {
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

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/org/domains", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "example.com",
        enrollmentMode: "invalid",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationDomain,
    ).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/zero/org/domains", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("removes a domain for an admin", async () => {
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

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
        body: { domainId: "domain_test123" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ message: "Domain removed" });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationDomain,
    ).toHaveBeenCalledWith({
      organizationId: orgId,
      domainId: "domain_test123",
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.remove({
        headers: {},
        body: { domainId: "domain_test123" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(
      context.mocks.clerk.organizations.deleteOrganizationDomain,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
        body: { domainId: "domain_test123" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(
      context.mocks.clerk.organizations.deleteOrganizationDomain,
    ).not.toHaveBeenCalled();
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
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
        body: { domainId: "domain_test123" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Access denied",
      code: "FORBIDDEN",
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationDomain,
    ).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies before calling Clerk", async () => {
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

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/org/domains", {
      method: "DELETE",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationDomain,
    ).not.toHaveBeenCalled();
  });
});
