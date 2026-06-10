import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { createStore } from "ccstate";
import { expect } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteFeatureSwitches$,
  seedFeatureSwitches$,
  type FeatureSwitchesFixture,
} from "./helpers/zero-feature-switches";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-feature-switches.test.ts`. The Givens
// use the existing `seedFeatureSwitches$` helper — direct DB seeding is an
// accepted "Open Helper Gap" because no public route currently lets a user
// create or delete these overrides. All Then assertions are through the
// contract's GET/POST/DELETE endpoints; no direct DB row reads remain.
//
// See `api.bdd.md` for the migration plan and helper gaps.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

describe("BDD /api/zero/feature-switches — auth boundary", () => {
  it("rejects every method when the request is unauthenticated", async () => {
    const c = client();

    const get = await accept(c.get({ headers: {} }), [401]);
    expect(get.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const update = await accept(
      c.update({ headers: {}, body: { switches: { dummy: true } } }),
      [401],
    );
    expect(update.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const del = await accept(c.delete({ headers: {} }), [401]);
    expect(del.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects every method when the session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    const c = client();

    const get = await accept(c.get({ headers: authHeaders() }), [401]);
    expect(get.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const update = await accept(
      c.update({ headers: authHeaders(), body: { switches: { dummy: true } } }),
      [401],
    );
    expect(update.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const del = await accept(c.delete({ headers: authHeaders() }), [401]);
    expect(del.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD /api/zero/feature-switches — lifecycle chain", () => {
  const track = createFixtureTracker<FeatureSwitchesFixture>((fixture) => {
    return store.set(deleteFeatureSwitches$, fixture, context.signal);
  });

  it("gwt-wt-wt: GET with no override row → POST creates → GET reflects", async () => {
    // Given: a brand-new user/org with no override row.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);
    const c = client();

    // When + Then: GET returns empty switches.
    const initial = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(initial.body).toStrictEqual({ switches: {} });

    // When + Then: POST creates the row, response body reflects the write.
    const created = await accept(
      c.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [200],
    );
    expect(created.body).toStrictEqual({ switches: { dummy: true } });

    // When + Then: a follow-up GET shows the same switches — no DB peek.
    const afterPost = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(afterPost.body).toStrictEqual({ switches: { dummy: true } });
  });

  it("gwt-wt-wt: POST merges (preserves untouched keys) → POST overrides", async () => {
    // Given: a fresh user/org.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId, userId }));
    mocks.clerk.session(userId, orgId);
    const c = client();

    // When + Then: POST {dummy: true}.
    const first = await accept(
      c.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [200],
    );
    expect(first.body).toStrictEqual({ switches: { dummy: true } });

    // When + Then: POST {lab: false} merges; untouched `dummy` is preserved.
    const merged = await accept(
      c.update({
        headers: authHeaders(),
        body: { switches: { lab: false } },
      }),
      [200],
    );
    expect(merged.body).toStrictEqual({
      switches: { dummy: true, lab: false },
    });

    // When + Then: POST {dummy: false} overrides the existing key; merge
    // strategy keeps `lab` (the merge never deletes untouched keys).
    const overridden = await accept(
      c.update({
        headers: authHeaders(),
        body: { switches: { dummy: false } },
      }),
      [200],
    );
    expect(overridden.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    // Then: a follow-up GET confirms the override is durable.
    const getAfter = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(getAfter.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });
  });

  it("gwt-wt-wt: DELETE clears all overrides → GET returns empty switches", async () => {
    // Given: a user with seeded overrides (the only step that still needs
    // the helper — recorded in api.bdd.md under "Open Helper Gaps").
    const fixture = await track(
      store.set(
        seedFeatureSwitches$,
        { dummy: true, lab: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // Sanity check: GET reflects the seeded switches.
    const before = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(before.body).toStrictEqual({
      switches: { dummy: true, lab: false },
    });

    // When + Then: DELETE returns the contract's success body.
    const deleted = await accept(c.delete({ headers: authHeaders() }), [200]);
    expect(deleted.body).toStrictEqual({ deleted: true });

    // When + Then: a follow-up GET returns the empty-switches response.
    const after = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(after.body).toStrictEqual({ switches: {} });
  });
});
