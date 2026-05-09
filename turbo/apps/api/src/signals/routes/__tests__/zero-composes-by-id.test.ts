import { randomUUID } from "node:crypto";

import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

describe("GET /api/zero/composes/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroComposesByIdContract);

    const response = await accept(
      client.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroComposesByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for a malformed compose id", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      "/api/zero/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      {
        method: "GET",
        headers: { authorization: "Bearer clerk-session" },
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("valid UUID");
  });

  it("returns 404 when the compose is not found", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComposesByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns the compose by id", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComposesByIdContract);

    const response = await accept(
      client.getById({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBe(composeId);
    expect(response.body.name).toBe(`agent-${composeId.slice(0, 8)}`);
  });

  it("returns 404 for a compose owned by a different org and user", async () => {
    const otherFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const otherComposeId = otherFixture.composeIds[0];
    if (!otherComposeId) {
      throw new Error("Expected seeded compose");
    }
    const callerUserId = `user_${randomUUID()}`;
    const callerOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(callerUserId, callerOrgId);

    const client = setupApp({ context })(zeroComposesByIdContract);

    const response = await accept(
      client.getById({
        params: { id: otherComposeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
