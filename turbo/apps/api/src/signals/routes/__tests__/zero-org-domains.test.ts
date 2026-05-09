import { randomUUID } from "node:crypto";

import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface SeededOrg {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
}

async function seedOrgMembership(args: SeededOrg): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgCache).values({
    orgId: args.orgId,
    slug: `org-${args.orgId.slice(-8)}`,
  });
  await writeDb.insert(orgMembersCache).values({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role,
  });
}

async function deleteOrgMembership(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await writeDb.delete(orgCache).where(eq(orgCache.orgId, orgId));
}

describe("GET /api/zero/org/domains", () => {
  const seededOrgIds: string[] = [];

  afterEach(async () => {
    while (seededOrgIds.length > 0) {
      const orgId = seededOrgIds.pop();
      if (orgId) {
        await deleteOrgMembership(orgId);
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
    await seedOrgMembership({ orgId, userId, role: "admin" });
    seededOrgIds.push(orgId);
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.domains).toBeInstanceOf(Array);
  });

  it("returns 403 when caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await seedOrgMembership({ orgId, userId, role: "member" });
    seededOrgIds.push(orgId);
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroOrgDomainsContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
