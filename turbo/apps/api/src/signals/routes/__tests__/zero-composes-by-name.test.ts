import { zeroComposesMainContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

const HEAD_VERSION_HEX = "a".repeat(64);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/composes (getByName)", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroComposesMainContract);

    const response = await accept(
      client.getByName({
        query: { name: "any-agent" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroComposesMainContract);

    const response = await accept(
      client.getByName({
        query: { name: "any-agent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the compose when found by name in the active org", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ headVersionId: HEAD_VERSION_HEX }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const composeId = fixture.composeIds[0]!;
    const expectedName = `agent-${composeId.slice(0, 8)}`;

    const client = setupApp({ context })(zeroComposesMainContract);

    const response = await accept(
      client.getByName({
        query: { name: expectedName },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: composeId,
      name: expectedName,
      headVersionId: HEAD_VERSION_HEX,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      content: null,
    });
  });

  it("returns 404 when no compose matches the name", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComposesMainContract);

    const response = await accept(
      client.getByName({
        query: { name: "nonexistent-agent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent compose not found: nonexistent-agent",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 when a compose with the same name exists in a different org", async () => {
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "shared-name-agent" }],
        },
        context.signal,
      ),
    );
    const sharedComposeId = otherFixture.composeIds[0]!;
    const sharedName = `agent-${sharedComposeId.slice(0, 8)}`;

    const myFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroComposesMainContract);

    const response = await accept(
      client.getByName({
        query: { name: sharedName },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent compose not found: ${sharedName}`,
        code: "NOT_FOUND",
      },
    });
  });
});
