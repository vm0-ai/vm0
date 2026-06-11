import { randomUUID } from "node:crypto";

import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

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

// BDD migration of the legacy `zero-default-agent.test.ts`.
// The 10 legacy `it()`s collapse into 3 BDD `it()`s:
// (1) auth + role chain (401 unauthenticated → 401 user
// has no active org → 403 non-admin member),
// (2) success + persistence + upsert chain (200 admin sets
// the default → 200 writes to org_metadata → 200 allows
// setting when none configured → 200 upsert creates the
// org_metadata row when missing → 200 upsert against an
// existing empty shell),
// (3) not-found + conflict + recovery chain (404 agent
// does not exist → 404 cross-org isolation → 409 unset
// an already-configured default → 409 set the default
// twice → 200 org_metadata is not clobbered by the 409
// → 200 re-set after the previous compose was deleted).

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

function apiClient() {
  return setupApp({ context })(orgDefaultAgentContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

const trackOrg = createFixtureTracker<OrgFixture>((fixture) => {
  return store.set(deleteOrgMetadata$, fixture.orgId, context.signal);
});

describe("BDD PUT /api/zero/default-agent — auth + role chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 user has no active org → 403 non-admin member", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a Clerk session with no active org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: sessionHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a fixture with a compose + a Clerk session as
    // `org:member`.

    // When + Then: 403 — Only org admins can set the
    // default agent.
    const memberFixture = uniqueOrgUser("zda-member");
    const { composeId: memberComposeId } = await store.set(
      seedCompose$,
      { orgId: memberFixture.orgId, userId: memberFixture.userId },
      context.signal,
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );
    const memberResponse = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: memberComposeId },
        headers: sessionHeaders(),
      }),
      [403],
    );
    expect(memberResponse.body).toStrictEqual({
      error: {
        message: "Only org admins can set the default agent",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD PUT /api/zero/default-agent — success + persistence + upsert chain", () => {
  it("gwt-wt-wt: 200 admin sets the default → 200 writes to org_metadata → 200 allows setting when none configured → 200 upsert creates the org_metadata row when missing → 200 upsert against an existing empty shell", async () => {
    // Given: a fresh fixture + a compose + a Clerk
    // session (default `org:admin`).

    // When + Then: 200 — the response body echoes the
    // agentId that was set.
    const adminFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-admin")),
    );
    const { composeId: adminComposeId } = await store.set(
      seedCompose$,
      { orgId: adminFixture.orgId, userId: adminFixture.userId },
      context.signal,
    );
    mocks.clerk.session(adminFixture.userId, adminFixture.orgId);
    const adminResponse = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: adminComposeId },
      headers: sessionHeaders(),
    });
    expect(adminResponse.status).toBe(200);
    if (adminResponse.status !== 200) {
      return;
    }
    expect(adminResponse.body.agentId).toBe(adminComposeId);

    // Given: a fresh fixture + a compose + a Clerk
    // session.

    // When + Then: 200 — the org_metadata row stores
    // the composeId.
    const writeFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-write")),
    );
    const { composeId: writeComposeId } = await store.set(
      seedCompose$,
      { orgId: writeFixture.orgId, userId: writeFixture.userId },
      context.signal,
    );
    mocks.clerk.session(writeFixture.userId, writeFixture.orgId);
    const writeResponse = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: writeComposeId },
      headers: sessionHeaders(),
    });
    expect(writeResponse.status).toBe(200);
    const stored = await store.set(
      getOrgMetadataDefaultAgent$,
      writeFixture.orgId,
      context.signal,
    );
    expect(stored).toBe(writeComposeId);

    // Given: a fixture where the org_metadata row has
    // no default agent configured + a compose.

    // When + Then: 200 — the response body echoes the
    // agentId and the default is persisted.
    const noneFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-none")),
    );
    const { composeId: noneComposeId } = await store.set(
      seedCompose$,
      { orgId: noneFixture.orgId, userId: noneFixture.userId },
      context.signal,
    );
    mocks.clerk.session(noneFixture.userId, noneFixture.orgId);
    const noneResponse = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: noneComposeId },
      headers: sessionHeaders(),
    });
    expect(noneResponse.status).toBe(200);
    if (noneResponse.status !== 200) {
      return;
    }
    expect(noneResponse.body.agentId).toBe(noneComposeId);

    // Given: a fixture whose org_metadata row was
    // deleted before the PUT + a compose.

    // When + Then: 200 — the upsert creates a brand new
    // org_metadata row holding the composeId.
    const upsertCreateFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-upsert-create")),
    );
    await store.set(
      deleteOrgMetadata$,
      upsertCreateFixture.orgId,
      context.signal,
    );
    const { composeId: upsertComposeId } = await store.set(
      seedCompose$,
      {
        orgId: upsertCreateFixture.orgId,
        userId: upsertCreateFixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(upsertCreateFixture.userId, upsertCreateFixture.orgId);
    const upsertCreateResponse = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: upsertComposeId },
      headers: sessionHeaders(),
    });
    expect(upsertCreateResponse.status).toBe(200);
    if (upsertCreateResponse.status !== 200) {
      return;
    }
    expect(upsertCreateResponse.body.agentId).toBe(upsertComposeId);
    const upsertStored = await store.set(
      getOrgMetadataDefaultAgent$,
      upsertCreateFixture.orgId,
      context.signal,
    );
    expect(upsertStored).toBe(upsertComposeId);

    // Given: a fixture with an existing org_metadata
    // shell (defaultAgentId=null) + a compose.

    // When + Then: 200 — the upsert overwrites the
    // existing shell with the new default agent.
    const freshOrgFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-fresh-org")),
    );
    await store.set(
      seedOrgMetadata$,
      { orgId: freshOrgFixture.orgId, defaultAgentId: null },
      context.signal,
    );
    const { composeId: freshOrgComposeId } = await store.set(
      seedCompose$,
      {
        orgId: freshOrgFixture.orgId,
        userId: freshOrgFixture.userId,
      },
      context.signal,
    );
    mocks.clerk.session(freshOrgFixture.userId, freshOrgFixture.orgId);
    const freshOrgResponse = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: freshOrgComposeId },
      headers: sessionHeaders(),
    });
    expect(freshOrgResponse.status).toBe(200);
    if (freshOrgResponse.status !== 200) {
      return;
    }
    expect(freshOrgResponse.body.agentId).toBe(freshOrgComposeId);
    const freshOrgStored = await store.set(
      getOrgMetadataDefaultAgent$,
      freshOrgFixture.orgId,
      context.signal,
    );
    expect(freshOrgStored).toBe(freshOrgComposeId);
  });
});

describe("BDD PUT /api/zero/default-agent — not-found + conflict + recovery chain", () => {
  it("gwt-wt-wt: 404 agent does not exist → 404 cross-org isolation → 409 unset an already-configured default → 409 set the default twice → 200 org_metadata is not clobbered by the 409 → 200 re-set after the previous compose was deleted", async () => {
    // Given: a fixture + a Clerk session + a synthetic
    // composeId that does not exist.

    // When + Then: 404 — Agent not found in this org.
    const missingFixture = uniqueOrgUser("zda-missing");
    mocks.clerk.session(missingFixture.userId, missingFixture.orgId);
    const missingResponse = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: "00000000-0000-0000-0000-000000000000" },
        headers: sessionHeaders(),
      }),
      [404],
    );
    expect(missingResponse.body).toMatchObject({
      error: {
        message: "Agent not found in this org",
        code: "NOT_FOUND",
      },
    });

    // Given: org A owns a compose + the request is
    // authenticated as a different user in org B with
    // org A's composeId.

    // When + Then: 404 — cross-org isolation.
    const orgAFixture = uniqueOrgUser("zda-org-a");
    const { composeId: orgAComposeId } = await store.set(
      seedCompose$,
      { orgId: orgAFixture.orgId, userId: orgAFixture.userId },
      context.signal,
    );
    const orgBFixture = uniqueOrgUser("zda-org-b");
    mocks.clerk.session(orgBFixture.userId, orgBFixture.orgId);
    const crossOrgResponse = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: orgAComposeId },
        headers: sessionHeaders(),
      }),
      [404],
    );
    expect(crossOrgResponse.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: a fixture with an already-configured
    // default agent.

    // When + Then: 409 — the unset is blocked by the
    // conflict guard.
    const unsetFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-unset")),
    );
    const { composeId: unsetComposeId } = await store.set(
      seedCompose$,
      { orgId: unsetFixture.orgId, userId: unsetFixture.userId },
      context.signal,
    );
    mocks.clerk.session(unsetFixture.userId, unsetFixture.orgId);
    const unsetFirst = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: unsetComposeId },
      headers: sessionHeaders(),
    });
    expect(unsetFirst.status).toBe(200);
    const unsetSecond = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: sessionHeaders(),
      }),
      [409],
    );
    expect(unsetSecond.body).toMatchObject({ error: { code: "CONFLICT" } });

    // Given: a fixture that just set its default agent.

    // When + Then: 409 — a second identical set is
    // rejected.
    const twiceFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-twice")),
    );
    const { composeId: twiceComposeId } = await store.set(
      seedCompose$,
      { orgId: twiceFixture.orgId, userId: twiceFixture.userId },
      context.signal,
    );
    mocks.clerk.session(twiceFixture.userId, twiceFixture.orgId);
    const twiceFirst = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: twiceComposeId },
      headers: sessionHeaders(),
    });
    expect(twiceFirst.status).toBe(200);
    const twiceSecond = await accept(
      apiClient().setDefaultAgent({
        query: {},
        body: { agentId: twiceComposeId },
        headers: sessionHeaders(),
      }),
      [409],
    );
    expect(twiceSecond.body).toMatchObject({ error: { code: "CONFLICT" } });

    // Given: a fixture with a configured default + a
    // subsequent 409 unset attempt.

    // When + Then: org_metadata still holds the
    // original composeId after the 409.
    const noClobberFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-no-clobber")),
    );
    const { composeId: noClobberComposeId } = await store.set(
      seedCompose$,
      { orgId: noClobberFixture.orgId, userId: noClobberFixture.userId },
      context.signal,
    );
    mocks.clerk.session(noClobberFixture.userId, noClobberFixture.orgId);
    const noClobberFirst = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: noClobberComposeId },
      headers: sessionHeaders(),
    });
    expect(noClobberFirst.status).toBe(200);
    const noClobberSecond = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: null },
      headers: sessionHeaders(),
    });
    expect(noClobberSecond.status).toBe(409);
    const noClobberStored = await store.set(
      getOrgMetadataDefaultAgent$,
      noClobberFixture.orgId,
      context.signal,
    );
    expect(noClobberStored).toBe(noClobberComposeId);

    // Given: a fixture that has set a default agent +
    // the first compose is deleted (FK cascade +
    // ON DELETE SET NULL clears the default).

    // When + Then: 200 — a second default agent can be
    // re-set after the recovery.
    const recoverFixture = await trackOrg(
      Promise.resolve(uniqueOrgUser("zda-recover")),
    );
    const firstCompose = await store.set(
      seedCompose$,
      { orgId: recoverFixture.orgId, userId: recoverFixture.userId },
      context.signal,
    );
    mocks.clerk.session(recoverFixture.userId, recoverFixture.orgId);
    const recoverFirst = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: firstCompose.composeId },
      headers: sessionHeaders(),
    });
    expect(recoverFirst.status).toBe(200);
    await deleteAgentCompose(firstCompose.composeId);
    const secondCompose = await store.set(
      seedCompose$,
      { orgId: recoverFixture.orgId, userId: recoverFixture.userId },
      context.signal,
    );
    const recoverSecond = await apiClient().setDefaultAgent({
      query: {},
      body: { agentId: secondCompose.composeId },
      headers: sessionHeaders(),
    });
    expect(recoverSecond.status).toBe(200);
    if (recoverSecond.status !== 200) {
      return;
    }
    expect(recoverSecond.body.agentId).toBe(secondCompose.composeId);
  });
});
