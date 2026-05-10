import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroSecretsByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { secrets } from "@vm0/db/schema/secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherSecret$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/secrets/:name", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({ params: { name: "ANY_KEY" }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ANY_KEY" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("deletes a secret successfully and removes the row", async () => {
    const fixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "DELETE_ME", type: "user" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await client.delete({
      params: { name: "DELETE_ME" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    // Row removed
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "DELETE_ME"),
        ),
      );
    expect(remaining).toStrictEqual([]);
  });

  it("returns 404 for a nonexistent secret", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "NONEXISTENT" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: 'Secret "NONEXISTENT" not found',
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 for a secret owned by another user (cross-user isolation)", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    // Another user in the same org has the secret named OTHER_USER_SECRET.
    await store.set(seedOtherSecret$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "OTHER_USER_SECRET" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the victim row is still there (not silently deleted).
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.name, "OTHER_USER_SECRET"),
        ),
      );
    expect(victim).toHaveLength(1);
  });

  it("returns 404 for a secret in another org (cross-org isolation)", async () => {
    const orgAFixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "ORG_A_SECRET", type: "user" }],
        context.signal,
      ),
    );

    // Authenticate as a different user in a different org.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ORG_A_SECRET" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the victim row is still there in org A.
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: secrets.id, orgId: secrets.orgId })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgAFixture.orgId),
          eq(secrets.name, "ORG_A_SECRET"),
        ),
      );
    expect(victim).toHaveLength(1);
    expect(victim[0]?.orgId).toBe(orgAFixture.orgId);
  });

  it("does NOT delete non-user-type secrets (type filter regression guard)", async () => {
    const fixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "CONNECTOR_SECRET", type: "connector" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "CONNECTOR_SECRET" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the connector secret row is preserved.
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: secrets.id, type: secrets.type })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "CONNECTOR_SECRET"),
        ),
      );
    expect(victim).toHaveLength(1);
    expect(victim[0]?.type).toBe("connector");
  });
});
