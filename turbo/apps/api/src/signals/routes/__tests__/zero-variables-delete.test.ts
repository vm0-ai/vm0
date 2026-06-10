import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroVariablesByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  authHeaders,
  createZeroVariableThroughApi,
  deleteZeroVariableThroughApi,
  listZeroVariablesThroughApi,
  type ZeroVariableRouteFixture,
} from "./helpers/zero-variable-routes";
import {
  deleteUserData$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/variables/:name", () => {
  const trackVariable = createFixtureTracker<ZeroVariableRouteFixture>(
    (fixture) => {
      return deleteZeroVariableThroughApi(
        context,
        mocks.clerk.session,
        fixture,
      );
    },
  );
  const trackLegacy = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({ params: { name: "ANY_VAR" }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ANY_VAR" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("deletes a variable successfully and removes it from the list", async () => {
    const fixture = await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        name: "DELETE_ME",
        value: "to-be-deleted",
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await client.delete({
      params: { name: "DELETE_ME" },
      headers: authHeaders(),
    });
    expect(response.status).toBe(204);

    await expect(listZeroVariablesThroughApi(context)).resolves.toStrictEqual(
      [],
    );
  });

  it("deletes only the user-owned variable when a connector-owned variable has the same name", async () => {
    const fixture = await trackLegacy(
      store.set(
        seedVariables$,
        [
          { name: "SHARED_NAME", value: "user-value" },
          {
            name: "SHARED_NAME",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await client.delete({
      params: { name: "SHARED_NAME" },
      headers: authHeaders(),
    });
    expect(response.status).toBe(204);

    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({
        name: variables.name,
        value: variables.value,
        type: variables.type,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
          eq(variables.name, "SHARED_NAME"),
        ),
      );
    expect(remaining).toStrictEqual([
      { name: "SHARED_NAME", value: "connector-value", type: "connector" },
    ]);
  });

  it("returns 404 when only a connector-owned variable exists", async () => {
    const fixture = await trackLegacy(
      store.set(
        seedVariables$,
        [
          {
            name: "CONNECTOR_ONLY",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "CONNECTOR_ONLY" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("returns 404 for a nonexistent variable", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "NONEXISTENT" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: 'Variable "NONEXISTENT" not found',
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 for a variable owned by another user (cross-user isolation)", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const owner = await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
        orgId,
        name: "OTHER_USER_VAR",
        value: "other-user",
      }),
    );
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "OTHER_USER_VAR" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    await expect(listZeroVariablesThroughApi(context)).resolves.toMatchObject([
      { name: "OTHER_USER_VAR", value: "other-user" },
    ]);
  });

  it("returns 404 for a variable in another org (cross-org isolation)", async () => {
    const orgAFixture = await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        name: "ORG_A_VAR",
        value: "value-a",
      }),
    );

    // Authenticate as a different user in a different org.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ORG_A_VAR" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(orgAFixture.userId, orgAFixture.orgId);
    await expect(listZeroVariablesThroughApi(context)).resolves.toMatchObject([
      { name: "ORG_A_VAR", value: "value-a" },
    ]);
  });
});
