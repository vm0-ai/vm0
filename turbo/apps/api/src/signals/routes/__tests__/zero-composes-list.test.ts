import { randomUUID } from "node:crypto";

import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
// Reusing compose-seeding helper from the team test module — same fixture
// shape (org/user/composes), no need to duplicate. Same precedent as
// zero-runs-queue.test.ts (PR #12402) reusing usage-insight helpers.
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

const HEAD_VERSION_HEX = "a".repeat(64);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/composes/list", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when the authenticated session has no active organization", async () => {
    // The list route preserves authRoute({acceptAnySandboxCapability: true})
    // and manually returns 400 with "Invalid request" to mirror web's
    // wording verbatim — switching to authRoute's built-in
    // requireOrganization check would change the message.
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns an empty list when the org has no composes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ composes: [] });
  });

  it("returns the org composes ordered by updatedAt desc", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "First Agent",
              description: "first",
              sound: "ding",
              headVersionId: HEAD_VERSION_HEX,
            },
            {
              displayName: "Second Agent",
              description: "second",
              sound: "pong",
              headVersionId: HEAD_VERSION_HEX,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.composes).toHaveLength(2);
    const names = response.body.composes.map((c) => {
      return c.name;
    });
    const expectedFirstName = `agent-${fixture.composeIds[0]?.slice(0, 8) ?? ""}`;
    const expectedSecondName = `agent-${fixture.composeIds[1]?.slice(0, 8) ?? ""}`;
    expect(names).toContain(expectedFirstName);
    expect(names).toContain(expectedSecondName);
    for (const compose of response.body.composes) {
      expect(compose.headVersionId).toBe(HEAD_VERSION_HEX);
      expect(typeof compose.updatedAt).toBe("string");
      expect(compose.id).toBeDefined();
    }
  });

  it("does not include composes from other orgs", async () => {
    const myFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "my-agent" }],
        },
        context.signal,
      ),
    );
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [{ displayName: "other-agent" }],
        },
        context.signal,
      ),
    );

    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.composes).toHaveLength(1);
    const [only] = response.body.composes;
    expect(only?.id).toBe(myFixture.composeIds[0]);
    expect(only?.displayName).toBe("my-agent");
    expect(
      response.body.composes.map((c) => {
        return c.id;
      }),
    ).not.toContain(otherFixture.composeIds[0]);
  });

  it("accepts sandbox tokens (matches web's acceptAnySandboxCapability behavior)", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroComposesListContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    // No composes seeded for the sandbox-derived orgId — empty list proves
    // the sandbox token reached the inner handler.
    expect(response.body).toStrictEqual({ composes: [] });
  });
});
