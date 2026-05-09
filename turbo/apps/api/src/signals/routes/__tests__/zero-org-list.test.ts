import { randomUUID } from "node:crypto";

import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
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

describe("GET /api/zero/org/list", () => {
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
    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns list of user orgs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `solo-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, slug, role: "admin" },
        context.signal,
      ),
    );

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs.length).toBeGreaterThanOrEqual(1);
    expect(response.body.orgs[0]).toHaveProperty("slug");
    expect(response.body.orgs[0]).toHaveProperty("role");
  });

  it("returns multiple orgs when user belongs to several", async () => {
    const userId = `user_${randomUUID()}`;
    const orgIdA = `org_${randomUUID()}`;
    const orgIdB = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: orgIdA, userId, slug: "team-alpha", role: "admin" },
        context.signal,
      ),
    );
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: orgIdB, userId, slug: "team-beta", role: "member" },
        context.signal,
      ),
    );

    mocks.clerk.session(userId, orgIdA);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs).toHaveLength(2);
    expect(response.body.orgs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "team-alpha", role: "admin" }),
        expect.objectContaining({ slug: "team-beta", role: "member" }),
      ]),
    );
  });
});
