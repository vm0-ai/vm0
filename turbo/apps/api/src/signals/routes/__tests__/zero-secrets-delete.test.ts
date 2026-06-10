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
  authHeaders,
  createZeroSecretThroughApi,
  deleteZeroSecretThroughApi,
  listZeroSecretsThroughApi,
  type ZeroSecretRouteFixture,
} from "./helpers/zero-secret-routes";
import {
  deleteUserData$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/secrets/:name", () => {
  const trackSecret = createFixtureTracker<ZeroSecretRouteFixture>(
    (fixture) => {
      return deleteZeroSecretThroughApi(context, mocks.clerk.session, fixture);
    },
  );
  const trackLegacy = createFixtureTracker<UserDataFixture>((fixture) => {
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
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("deletes a secret successfully and removes it from the list", async () => {
    const fixture = await trackSecret(
      Promise.resolve({
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
        name: "DELETE_ME",
      }),
    );
    await createZeroSecretThroughApi(context, mocks.clerk.session, fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await client.delete({
      params: { name: "DELETE_ME" },
      headers: authHeaders(),
    });
    expect(response.status).toBe(204);

    await expect(listZeroSecretsThroughApi(context)).resolves.toStrictEqual([]);
  });

  it("returns 404 for a nonexistent secret", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "NONEXISTENT" },
        headers: authHeaders(),
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
    const orgId = `org_${randomUUID()}`;
    const owner = await trackSecret(
      Promise.resolve({
        orgId,
        userId: `user_${randomUUID()}`,
        name: "OTHER_USER_SECRET",
      }),
    );
    await createZeroSecretThroughApi(context, mocks.clerk.session, owner);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "OTHER_USER_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    await expect(listZeroSecretsThroughApi(context)).resolves.toMatchObject([
      { name: "OTHER_USER_SECRET", type: "user" },
    ]);
  });

  it("returns 404 for a secret in another org (cross-org isolation)", async () => {
    const orgAFixture = await trackSecret(
      Promise.resolve({
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
        name: "ORG_A_SECRET",
      }),
    );
    await createZeroSecretThroughApi(context, mocks.clerk.session, orgAFixture);

    // Authenticate as a different user in a different org.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ORG_A_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(orgAFixture.userId, orgAFixture.orgId);
    await expect(listZeroSecretsThroughApi(context)).resolves.toMatchObject([
      { name: "ORG_A_SECRET", type: "user" },
    ]);
  });

  it("does NOT delete non-user-type secrets (type filter regression guard)", async () => {
    const fixture = await trackLegacy(
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
        headers: authHeaders(),
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
