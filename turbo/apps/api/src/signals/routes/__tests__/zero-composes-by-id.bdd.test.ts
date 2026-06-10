import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for GET /api/zero/composes/:id. The compose precondition
// is built by creating an agent through the public API (an agent create writes a
// compose whose id is the agent id). See `api.bdd.md` (CHAIN-COMPOSE-READ).
const context = testContext();

describe("compose read by id (API-first BDD)", () => {
  it("returns the compose created for an agent, and 404 once unknown", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Given an agent (and therefore a compose) created through the API.
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Compose Owner" },
      }),
      [201],
    );
    const composeId = created.body.agentId;

    // When the compose is read by id. Then it is returned.
    const fetched = await accept(
      api.composesById.getById({
        params: { id: composeId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(fetched.body.id).toBe(composeId);
    expect(typeof fetched.body.name).toBe("string");
    expect(fetched.body.name.length).toBeGreaterThan(0);

    // Then an unknown id is not found.
    const missing = await accept(
      api.composesById.getById({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });

  it("rejects a malformed id, unauthenticated, no-org, and cross-org reads", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();

    // Unauthenticated.
    const unauth = await accept(
      api.composesById.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Authenticated but no active organization.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.composesById.getById({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // A malformed (non-UUID) id.
    api.actAsAdmin();
    const malformed = await accept(
      api.composesById.getById({
        params: { id: "91fc0bd84bba673393d9adfc1a0f4dec" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("BAD_REQUEST");
    expect(malformed.body.error.message).toContain("valid UUID");

    // A compose owned by a different org (no existence leak).
    const owner = api.actAsAdmin();
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Other org agent" },
      }),
      [201],
    );
    api.actAsAdmin();
    const crossOrg = await accept(
      api.composesById.getById({
        params: { id: created.body.agentId },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(crossOrg.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
    expect(owner.orgId).toStrictEqual(expect.any(String));
  });
});
