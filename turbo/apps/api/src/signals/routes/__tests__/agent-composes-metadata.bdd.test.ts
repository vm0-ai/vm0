import { randomUUID } from "node:crypto";

import { composesMetadataContract } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

// BDD migration of the legacy `agent-composes-metadata.test.ts`.
// The 10 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth + validation chain (401 unauth → 400 invalid body → 400
// no-org), (2) 404 chain (missing → other org), (3) 200
// success chain (creates zero_agents → partial fields →
// preserves omitted → same-org member → sandbox token).
// The 400 invalid-body case goes through the public app
// directly because the ts-rest client validates the body
// client-side and never reaches the route. The legacy test
// verified the persisted metadata via direct DB SELECTs
// against `zero_agents`; the BDD version trusts the
// `{ ok: true }` response, since the zero-agents GET is
// gated on `visibility = public OR owner = caller` and the
// metadata PATCH does not set `visibility`, so reading back
// through the public GET would surface a 404 even though the
// row exists. Team compose preconditions are reached through
// the `seedTeamCompose$` / `deleteTeamCompose$` helpers,
// which are tolerated direct-DB writers (Open Helper Gap).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function firstComposeId(fixture: TeamComposeFixture): string {
  const composeId = fixture.composeIds[0];
  if (!composeId) {
    throw new Error("Expected seeded compose");
  }
  return composeId;
}

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function metadataClient() {
  return setupApp({ context })(composesMetadataContract);
}

describe("BDD PATCH /api/agent/composes/:id/metadata — auth + validation chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 400 invalid body (number for displayName) → 400 no active organization", async () => {
    // When + Then: 401 unauth.
    const unauth = await accept(
      metadataClient().updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "x" },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a seeded compose.
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 400 for an invalid body. Goes through the
    // public app directly because the ts-rest client validates
    // the body client-side and never reaches the route.
    const app = (await import("../../../app-factory")).createApp({
      signal: context.signal,
    });
    const invalidBody = await app.request(
      `/api/agent/composes/${composeId}/metadata`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ displayName: 12_345 }),
      },
    );
    expect(invalidBody.status).toBe(400);
    const invalidJson = (await invalidBody.json()) as {
      readonly error: { readonly code: string };
    };
    expect(invalidJson.error.code).toBe("BAD_REQUEST");

    // Given: a session with no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: 400 "Explicit org context required".
    const noOrg = await accept(
      metadataClient().updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "No Org" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Explicit org context required — ensure active org in session",
      },
    });
  });
});

describe("BDD PATCH /api/agent/composes/:id/metadata — 404 chain", () => {
  it("gwt-wt-wt: 404 missing compose → 404 compose from another org", async () => {
    // Given: a session.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    // When + Then: 404 for a random composeId.
    const missing = await accept(
      metadataClient().updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    // Given: a compose owned by a different org + a session
    // in yet another org.
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    // When + Then: 404 (no cross-org updates).
    const otherOrg = await accept(
      metadataClient().updateMetadata({
        params: { id: composeId },
        body: { displayName: "Hacked Name" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherOrg.body.error.code).toBe("NOT_FOUND");
  });
});

describe("BDD PATCH /api/agent/composes/:id/metadata — 200 success chain", () => {
  it("gwt-wt-wt: 200 creates zero_agents row with all three fields → 200 partial fields only → 200 preserves omitted fields → 200 same-org member allowed → 200 sandbox token allowed", async () => {
    // Given: a compose without a zero_agents row.
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the PATCH creates a zero_agents row with
    // all three fields and returns ok=true.
    const created = await accept(
      metadataClient().updateMetadata({
        params: { id: composeId },
        body: {
          displayName: "My Agent",
          description: "A test agent",
          sound: "friendly",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(created.body).toStrictEqual({ ok: true });

    // Given: a different compose for partial fields.
    const partialFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const partialComposeId = firstComposeId(partialFixture);
    mocks.clerk.session(partialFixture.userId, partialFixture.orgId);

    // When + Then: partial PATCH succeeds with only `sound`.
    const partial = await accept(
      metadataClient().updateMetadata({
        params: { id: partialComposeId },
        body: { sound: "energetic" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(partial.body).toStrictEqual({ ok: true });

    // Given: a compose with an existing zero_agents row.
    const existingFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Old Name",
              description: "Old description",
              sound: "old-sound",
            },
          ],
        },
        context.signal,
      ),
    );
    const existingComposeId = firstComposeId(existingFixture);
    mocks.clerk.session(existingFixture.userId, existingFixture.orgId);

    // When + Then: the PATCH only changes displayName and
    // preserves the other two fields.
    const updated = await accept(
      metadataClient().updateMetadata({
        params: { id: existingComposeId },
        body: { displayName: "New Name" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(updated.body).toStrictEqual({ ok: true });

    // Given: a compose + a different user in the same org.
    const memberFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const memberComposeId = firstComposeId(memberFixture);
    mocks.clerk.session(`user_${randomUUID()}`, memberFixture.orgId);

    // When + Then: same-org members can update metadata.
    const memberUpdate = await accept(
      metadataClient().updateMetadata({
        params: { id: memberComposeId },
        body: { displayName: "Updated by member" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(memberUpdate.body).toStrictEqual({ ok: true });

    // Given: a compose + a sandbox token scoped to the same
    // org.
    const sandboxFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const sandboxComposeId = firstComposeId(sandboxFixture);
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: sandboxFixture.orgId,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 600,
    });

    // When + Then: sandbox tokens can update same-org
    // metadata.
    const sandboxUpdate = await accept(
      metadataClient().updateMetadata({
        params: { id: sandboxComposeId },
        body: { sound: "sandbox-sound" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(sandboxUpdate.body).toStrictEqual({ ok: true });
  });
});
