import { randomUUID } from "node:crypto";

import { zeroVariablesContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherVariable$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

describe("GET /api/zero/variables", () => {
  it("returns current user variables sorted by name", async () => {
    const createdAt = new Date("2026-02-02T03:04:05.000Z");
    const updatedAt = new Date("2026-02-03T03:04:05.000Z");
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "Z_REGION",
            value: "us-west-2",
            description: null,
            createdAt,
            updatedAt,
          },
          {
            name: "A_ENDPOINT",
            value: "https://api.example.test",
            description: "endpoint",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherVariable$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.variables).toHaveLength(2);
    expect(response.body.variables).toMatchObject([
      {
        name: "A_ENDPOINT",
        value: "https://api.example.test",
        description: "endpoint",
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
      {
        name: "Z_REGION",
        value: "us-west-2",
        description: null,
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
    ]);
  });

  it("returns an empty list when the user has no variables", async () => {
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ variables: [] });
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
        headers: { authorization: "Bearer clerk-session" },
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
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_VARIABLE",
          value: "variable-value-123",
          description: "Test variable",
        },
      }),
      [200],
    );

    expect(response).toMatchObject({
      body: {
        id: expect.any(String),
        name: "MY_VARIABLE",
        value: "variable-value-123",
        description: "Test variable",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
  });

  it("updates an existing variable without creating a duplicate", async () => {
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "MY_VARIABLE",
            value: "value-v1",
            description: null,
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_VARIABLE",
          value: "value-v2",
          description: "Updated description",
        },
      }),
      [200],
    );

    expect(response).toMatchObject({
      body: {
        name: "MY_VARIABLE",
        value: "value-v2",
        description: "Updated description",
      },
    });

    const listResponse = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listResponse).toMatchObject({
      body: {
        variables: [
          {
            name: "MY_VARIABLE",
            value: "value-v2",
            description: "Updated description",
          },
        ],
      },
    });
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
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
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
