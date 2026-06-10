import { randomUUID } from "node:crypto";

import { zeroVariablesContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

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
  setZeroVariableThroughApi,
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
const trackLegacy = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});
const trackVariable = createFixtureTracker<ZeroVariableRouteFixture>(
  (fixture) => {
    return deleteZeroVariableThroughApi(context, mocks.clerk.session, fixture);
  },
);

describe("GET /api/zero/variables", () => {
  it("returns current user variables sorted by name", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        userId,
        orgId,
        name: "Z_REGION",
        value: "us-west-2",
      }),
    );
    await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        userId,
        orgId,
        name: "A_ENDPOINT",
        value: "https://api.example.test",
        description: "endpoint",
      }),
    );
    await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
        orgId,
        name: "OTHER_USER_VAR",
        value: "other-user",
      }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.variables).toHaveLength(2);
    expect(response.body.variables).toMatchObject([
      {
        name: "A_ENDPOINT",
        value: "https://api.example.test",
        description: "endpoint",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      {
        name: "Z_REGION",
        value: "us-west-2",
        description: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("returns an empty list when the user has no variables", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ variables: [] });
  });

  it("does not return connector-owned variables", async () => {
    const fixture = await trackLegacy(
      store.set(
        seedVariables$,
        [
          { name: "USER_VISIBLE", value: "user-value" },
          {
            name: "CONNECTOR_INTERNAL",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.variables).toMatchObject([
      { name: "USER_VISIBLE", value: "user-value" },
    ]);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("POST /api/zero/variables", () => {
  it("creates a variable for the authenticated user", async () => {
    const fixture = await trackVariable(
      Promise.resolve({
        orgId: `org_${randomUUID().slice(0, 8)}`,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "MY_VARIABLE",
      }),
    );
    const variable = await setZeroVariableThroughApi(
      context,
      mocks.clerk.session,
      fixture,
      {
        value: "variable-value-123",
        description: "Test variable",
      },
    );

    expect(variable).toMatchObject({
      id: expect.any(String),
      name: "MY_VARIABLE",
      value: "variable-value-123",
      description: "Test variable",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await expect(listZeroVariablesThroughApi(context)).resolves.toMatchObject([
      {
        name: "MY_VARIABLE",
        value: "variable-value-123",
        description: "Test variable",
      },
    ]);
  });

  it("updates an existing variable without creating a duplicate", async () => {
    const fixture = await trackVariable(
      createZeroVariableThroughApi(context, mocks.clerk.session, {
        name: "MY_VARIABLE",
        value: "value-v1",
      }),
    );
    const variable = await setZeroVariableThroughApi(
      context,
      mocks.clerk.session,
      fixture,
      {
        value: "value-v2",
        description: "Updated description",
      },
    );

    expect(variable).toMatchObject({
      name: "MY_VARIABLE",
      value: "value-v2",
      description: "Updated description",
    });

    await expect(listZeroVariablesThroughApi(context)).resolves.toMatchObject([
      {
        name: "MY_VARIABLE",
        value: "value-v2",
        description: "Updated description",
      },
    ]);
  });

  it("updates only the user-owned variable when a connector-owned variable has the same name", async () => {
    const fixture = await trackLegacy(
      store.set(
        seedVariables$,
        [
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

    const client = setupApp({ context })(zeroVariablesContract);

    await accept(
      client.set({
        headers: authHeaders(),
        body: {
          name: "SHARED_NAME",
          value: "user-value",
        },
      }),
      [200],
    );

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
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
      )
      .orderBy(variables.type);
    expect(rows).toStrictEqual([
      { name: "SHARED_NAME", value: "connector-value", type: "connector" },
      { name: "SHARED_NAME", value: "user-value", type: "user" },
    ]);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.set({
        headers: {},
        body: {
          name: "MY_VARIABLE",
          value: "variable-value-123",
        },
      }),
      [401],
    );

    expect(response).toMatchObject({
      status: 401,
      body: {
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      },
    });
  });

  it("returns 400 for an invalid variable name", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.set({
        headers: authHeaders(),
        body: {
          name: "invalid name with spaces",
          value: "variable-value-123",
        },
      }),
      [400],
    );

    expect(response).toMatchObject({
      body: {
        error: { code: "BAD_REQUEST" },
      },
    });
  });
});
