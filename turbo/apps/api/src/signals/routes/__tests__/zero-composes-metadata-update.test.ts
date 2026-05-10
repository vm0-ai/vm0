import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { zeroComposesMetadataContract } from "@vm0/api-contracts/contracts/zero-composes";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("PATCH /api/zero/composes/:id/metadata", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        body: { displayName: "x" },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("updates compose metadata on a fresh zero_agents row", async () => {
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

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: composeId },
        body: {
          displayName: "Test Display Name",
          description: "Test description",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("Test Display Name");
    expect(row?.description).toBe("Test description");
    expect(row?.sound).toBeNull();
  });

  it("returns 404 when compose not found", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });

  it("allows a non-owner same-org member to update (canAccessCompose semantics)", async () => {
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
    const composeId = owner.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }

    // Authenticate as a different user in the same org. Web's
    // canAccessCompose admits org-mate access to PATCH metadata; the api
    // mirrors that policy verbatim per the migration's logic-unchanged rule.
    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId);

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: composeId },
        body: { displayName: "Org-mate Display" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    // displayName updated; description / sound preserved (UPDATE-on-conflict
    // path because the owner already had a zero_agents row seeded).
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("Org-mate Display");
    expect(row?.description).toBe("owner desc");
    expect(row?.sound).toBe("owner sound");
  });

  it("returns 404 for a compose in another org (cross-org isolation)", async () => {
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
    const composeId = owner.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }

    // Authenticate as a different user in a different org. canAccessCompose
    // rejects: neither orgs match nor user owns the compose.
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: composeId },
        body: { displayName: "hacked" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");

    // Sanity: the owner's row is unchanged.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("owner display");
    expect(row?.description).toBe("owner desc");
    expect(row?.sound).toBe("owner sound");
  });

  it("partial update preserves unprovided fields (UPDATE-on-conflict path)", async () => {
    const fixture = await track(
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
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComposesMetadataContract);
    const response = await accept(
      client.update({
        params: { id: composeId },
        body: { displayName: "Updated Display" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    // Only displayName changes; description and sound preserved.
    expect(row?.displayName).toBe("Updated Display");
    expect(row?.description).toBe("Initial description");
    expect(row?.sound).toBe("initial-sound");
  });
});
