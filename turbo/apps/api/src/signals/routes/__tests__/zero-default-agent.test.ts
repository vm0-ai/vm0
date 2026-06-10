import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import { agentComposes } from "@vm0/db/schema/agent-compose";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgMetadata$,
  getOrgMetadataDefaultAgent$,
  seedOrgMetadata$,
} from "./helpers/zero-org-metadata";
import { seedCompose$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface OrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

function uniqueOrgUser(prefix: string): OrgFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

async function deleteAgentCompose(composeId: string): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(agentComposes).where(eq(agentComposes.id, composeId));
}

describe("PUT /api/zero/default-agent", () => {
  const trackOrg = createFixtureTracker<OrgFixture>((fixture) => {
    return store.set(deleteOrgMetadata$, fixture.orgId, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 403 for non-admin members (explicit admin-gate)", async () => {
    const fixture = uniqueOrgUser("zda-member");
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can set the default agent",
        code: "FORBIDDEN",
      },
    });
  });

  it("allows admin to set default agent", async () => {
    const fixture = uniqueOrgUser("zda-admin");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.agentId).toBe(composeId);
  });

  it("writes the default agent to org_metadata (DB read-after-write)", async () => {
    const fixture = uniqueOrgUser("zda-write");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);

    const stored = await store.set(
      getOrgMetadataDefaultAgent$,
      fixture.orgId,
      context.signal,
    );
    expect(stored).toBe(composeId);
  });

  it("allows setting default agent when none is configured", async () => {
    const fixture = uniqueOrgUser("zda-none");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.agentId).toBe(composeId);
  });

  it("upsert creates the org_metadata row when missing", async () => {
    const fixture = uniqueOrgUser("zda-upsert-create");
    await trackOrg(Promise.resolve(fixture));
    // Ensure the org_metadata row does NOT exist before the PUT
    await store.set(deleteOrgMetadata$, fixture.orgId, context.signal);

    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.agentId).toBe(composeId);

    const stored = await store.set(
      getOrgMetadataDefaultAgent$,
      fixture.orgId,
      context.signal,
    );
    expect(stored).toBe(composeId);
  });

  it("returns 404 when agent does not exist", async () => {
    const fixture = uniqueOrgUser("zda-missing");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: "00000000-0000-0000-0000-000000000000" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        message: "Agent not found in this org",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 when agent belongs to a different org (cross-org isolation)", async () => {
    const orgAFixture = uniqueOrgUser("zda-org-a");
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: orgAFixture.orgId, userId: orgAFixture.userId },
      context.signal,
    );

    // Authenticate as a different user in a different org
    const orgBFixture = uniqueOrgUser("zda-org-b");
    mocks.clerk.session(orgBFixture.userId, orgBFixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 409 when trying to unset an already-configured default", async () => {
    const fixture = uniqueOrgUser("zda-unset");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    // First: set the default
    const first = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(first.status).toBe(200);

    // Second: attempt to unset — blocked by 409 guard
    const second = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(second.body).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("returns 409 when setting the default agent twice", async () => {
    const fixture = uniqueOrgUser("zda-twice");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const first = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(first.status).toBe(200);

    const second = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(second.body).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("does not update org_metadata when 409 conflict prevents unsetting", async () => {
    const fixture = uniqueOrgUser("zda-no-clobber");
    await trackOrg(Promise.resolve(fixture));
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const first = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(first.status).toBe(200);

    // Attempt to unset — should be 409
    const second = await client.setDefaultAgent({
      query: {},
      body: { agentId: null },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(second.status).toBe(409);

    // org_metadata should still hold the original value
    const stored = await store.set(
      getOrgMetadataDefaultAgent$,
      fixture.orgId,
      context.signal,
    );
    expect(stored).toBe(composeId);
  });

  it("allows re-setting the default agent after the previous compose was deleted", async () => {
    const fixture = uniqueOrgUser("zda-recover");
    await trackOrg(Promise.resolve(fixture));
    const first = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const set1 = await client.setDefaultAgent({
      query: {},
      body: { agentId: first.composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(set1.status).toBe(200);

    // Delete the first compose — FK cascade clears zero_agents,
    // FK ON DELETE SET NULL clears org_metadata.defaultAgentId.
    await deleteAgentCompose(first.composeId);

    // A second default agent should now be settable
    const second = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const set2 = await client.setDefaultAgent({
      query: {},
      body: { agentId: second.composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(set2.status).toBe(200);
    if (set2.status !== 200) {
      return;
    }
    expect(set2.body.agentId).toBe(second.composeId);
  });

  it("upsert creates the org_metadata row when org_metadata never existed", async () => {
    // Differs from the "missing row" case by also exercising the
    // seedOrgMetadata helper for a freshly-seeded org row.
    const fixture = uniqueOrgUser("zda-fresh-org");
    await trackOrg(Promise.resolve(fixture));
    // Seed an empty row first to mimic an org that has only the metadata
    // shell but no default-agent yet, then immediately overwrite by PUT.
    await store.set(
      seedOrgMetadata$,
      { orgId: fixture.orgId, defaultAgentId: null },
      context.signal,
    );

    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(orgDefaultAgentContract);
    const response = await client.setDefaultAgent({
      query: {},
      body: { agentId: composeId },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.agentId).toBe(composeId);

    const stored = await store.set(
      getOrgMetadataDefaultAgent$,
      fixture.orgId,
      context.signal,
    );
    expect(stored).toBe(composeId);
  });
});
