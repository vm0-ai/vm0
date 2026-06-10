import { randomUUID } from "node:crypto";

import { zeroComposesMetadataContract } from "@vm0/api-contracts/contracts/zero-composes";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of `zero-composes-metadata-update.test.ts`.
// The 6 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (200 fresh-row update → 404 unknown →
// 200 org-mate update → 404 cross-org → 200 partial
// update preserves unprovided fields).
//
// The Given uses `seedTeamCompose$` (Open Helper Gap —
// no public route creates a compose without going
// through POST). The Then assertions read the persisted
// zero_agents row through the DB to verify the
// on-conflict upsert behavior (the public response
// returns `{ ok: true }` and does not surface the
// updated fields).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroComposesMetadataContract);
}

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD PATCH /api/zero/composes/:id/metadata — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.update({
        params: { id: randomUUID() },
        body: { displayName: "x" },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.update({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD PATCH /api/zero/composes/:id/metadata — full coverage chain", () => {
  it("gwt-wt-wt: 200 fresh-row update → 404 unknown → 200 org-mate update → 404 cross-org → 200 partial update preserves unprovided fields", async () => {
    // Given: a fresh team with one compose, withZeroAgent:
    // false (no zero_agents row yet, so the route must
    // INSERT one).
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 — the route inserts a new
    // zero_agents row with the supplied displayName and
    // description; sound remains null.
    const inserted = await accept(
      client().update({
        params: { id: composeId },
        body: {
          displayName: "Test Display Name",
          description: "Test description",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(inserted.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [insertedRow] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(insertedRow?.displayName).toBe("Test Display Name");
    expect(insertedRow?.description).toBe("Test description");
    expect(insertedRow?.sound).toBeNull();

    // Given: a fresh caller that has nothing to do with
    // the compose.
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    // When + Then: 404 — an unknown id returns not-found.
    const unknown = await accept(
      client().update({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    // Given: a fresh owner fixture with displayName +
    // description + sound; a non-owner same-org member
    // authenticates.
    const owner = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "owner display",
              description: "owner desc",
              sound: "owner sound",
            },
          ],
        },
        context.signal,
      ),
    );
    const ownerComposeId = owner.composeIds[0];
    if (!ownerComposeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId);

    // When + Then: 200 — the org-mate can update the
    // displayName; description + sound are preserved
    // (the route uses an on-conflict update).
    const orgMate = await accept(
      client().update({
        params: { id: ownerComposeId },
        body: { displayName: "Org-mate Display" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(orgMate.body).toStrictEqual({ ok: true });

    const [orgMateRow] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, ownerComposeId));
    expect(orgMateRow?.displayName).toBe("Org-mate Display");
    expect(orgMateRow?.description).toBe("owner desc");
    expect(orgMateRow?.sound).toBe("owner sound");

    // Given: a fresh caller from a different org.
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    // When + Then: 404 — a cross-org caller cannot
    // update another team's compose.
    const crossOrg = await accept(
      client().update({
        params: { id: ownerComposeId },
        body: { displayName: "hacked" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    // Then: the owner's row is unchanged.
    const [crossOrgRow] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, ownerComposeId));
    expect(crossOrgRow?.displayName).toBe("Org-mate Display");
    expect(crossOrgRow?.description).toBe("owner desc");
    expect(crossOrgRow?.sound).toBe("owner sound");

    // Given: a fresh fixture with full metadata; the
    // owner authenticates and supplies only displayName.
    const partialFx = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Initial Display",
              description: "Initial description",
              sound: "initial-sound",
            },
          ],
        },
        context.signal,
      ),
    );
    const partialComposeId = partialFx.composeIds[0];
    if (!partialComposeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(partialFx.userId, partialFx.orgId);

    // When + Then: 200 — only displayName is changed;
    // description + sound are preserved.
    const partial = await accept(
      client().update({
        params: { id: partialComposeId },
        body: { displayName: "Updated Display" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(partial.body).toStrictEqual({ ok: true });

    const [partialRow] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, partialComposeId));
    expect(partialRow?.displayName).toBe("Updated Display");
    expect(partialRow?.description).toBe("Initial description");
    expect(partialRow?.sound).toBe("initial-sound");
  });
});
