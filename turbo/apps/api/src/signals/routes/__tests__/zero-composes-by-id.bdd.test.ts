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

  it("lists the org's composes and excludes a deleted one", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Then a new org has no composes.
    const empty = await accept(
      api.composesList.list({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ composes: [] });

    // Given two agents (composes) created through the API.
    const first = await accept(
      api.agents.create({ headers: SESSION_AUTH, body: { displayName: "A" } }),
      [201],
    );
    const second = await accept(
      api.agents.create({ headers: SESSION_AUTH, body: { displayName: "B" } }),
      [201],
    );

    // Then both appear in the list.
    const listed = await accept(
      api.composesList.list({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.composes
        .map((compose) => {
          return compose.id;
        })
        .sort(),
    ).toStrictEqual([first.body.agentId, second.body.agentId].sort());

    // When one compose is deleted. Then the list excludes it and GET 404s.
    await accept(
      api.composesById.delete({
        params: { id: first.body.agentId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.composesList.list({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(
      afterDelete.body.composes.map((compose) => {
        return compose.id;
      }),
    ).toStrictEqual([second.body.agentId]);
    await accept(
      api.composesById.getById({
        params: { id: first.body.agentId },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });

  it("rejects compose list/delete without auth or organization, and unknown/cross-org delete", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();

    // Unauthenticated.
    await accept(api.composesList.list({ query: {}, headers: {} }), [401]);
    await accept(
      api.composesById.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    // A list with no active organization reports 400.
    api.actAsNoOrg();
    await accept(
      api.composesList.list({ query: {}, headers: SESSION_AUTH }),
      [400],
    );

    // Unknown id and a compose owned by a different org.
    api.actAsAdmin();
    await accept(
      api.composesById.delete({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    const created = await accept(
      api.agents.create({ headers: SESSION_AUTH, body: { displayName: "X" } }),
      [201],
    );
    api.actAsAdmin();
    await accept(
      api.composesById.delete({
        params: { id: created.body.agentId },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });

  it("reads a compose by name, and 404s for unknown / cross-org names", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const owner = api.actAsAdmin();

    // Given an agent (compose) created through the API, with a known name.
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Named" },
      }),
      [201],
    );
    const composeId = created.body.agentId;
    const byId = await accept(
      api.composesById.getById({
        params: { id: composeId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    const name = byId.body.name;

    // When the compose is read by name. Then it is returned (metadata only).
    const byName = await accept(
      api.composesMain.getByName({ query: { name }, headers: SESSION_AUTH }),
      [200],
    );
    expect(byName.body).toMatchObject({ id: composeId, name });
    expect(byName.body.headVersionId).toMatch(/^[a-f0-9]{64}$/);

    // Then an unknown name is not found.
    const missing = await accept(
      api.composesMain.getByName({
        query: { name: "nonexistent-agent" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "Agent compose not found: nonexistent-agent",
        code: "NOT_FOUND",
      },
    });

    // Then the same name in a different org is not found, and unauthenticated
    // / no-org reads are rejected.
    api.actAsAdmin();
    const crossOrg = await accept(
      api.composesMain.getByName({ query: { name }, headers: SESSION_AUTH }),
      [404],
    );
    expect(crossOrg.body).toStrictEqual({
      error: {
        message: `Agent compose not found: ${name}`,
        code: "NOT_FOUND",
      },
    });
    await accept(
      api.composesMain.getByName({ query: { name: "any" }, headers: {} }),
      [401],
    );
    api.actAsNoOrg();
    await accept(
      api.composesMain.getByName({
        query: { name: "any" },
        headers: SESSION_AUTH,
      }),
      [401],
    );
    expect(owner.orgId).toStrictEqual(expect.any(String));
  });

  it("updates compose metadata (full + partial), allows same-org members, and 404s", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;
    const owner = api.actAsMember({ userId: `user_${randomUUID()}`, orgId });

    // Given an agent (compose) created by an org member.
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Initial", description: "Initial desc" },
      }),
      [201],
    );
    const id = created.body.agentId;

    // When metadata is fully updated. Then a follow-up agent GET reflects it.
    const updated = await accept(
      api.composesMetadata.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { displayName: "Updated Name", description: "Updated desc" },
      }),
      [200],
    );
    expect(updated.body).toStrictEqual({ ok: true });
    const afterFull = await accept(
      api.agentsById.get({ params: { id }, headers: SESSION_AUTH }),
      [200],
    );
    expect(afterFull.body).toMatchObject({
      displayName: "Updated Name",
      description: "Updated desc",
    });

    // When only the display name is updated. Then the description is preserved.
    await accept(
      api.composesMetadata.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { displayName: "Name Only" },
      }),
      [200],
    );
    const afterPartial = await accept(
      api.agentsById.get({ params: { id }, headers: SESSION_AUTH }),
      [200],
    );
    expect(afterPartial.body).toMatchObject({
      displayName: "Name Only",
      description: "Updated desc",
    });

    // When a different member of the same org updates it. Then it is allowed.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await accept(
      api.composesMetadata.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { description: "Edited by another member" },
      }),
      [200],
    );

    // Then unknown and cross-org composes are not found.
    api.actAsMember({ userId: owner.userId, orgId });
    await accept(
      api.composesMetadata.update({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
        body: { displayName: "x" },
      }),
      [404],
    );
    api.actAsAdmin();
    await accept(
      api.composesMetadata.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { displayName: "x" },
      }),
      [404],
    );
  });

  it("rejects unauthenticated and no-organization metadata updates", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    await accept(
      api.composesMetadata.update({
        params: { id },
        headers: {},
        body: { displayName: "x" },
      }),
      [401],
    );
    api.actAsNoOrg();
    await accept(
      api.composesMetadata.update({
        params: { id },
        headers: SESSION_AUTH,
        body: { displayName: "Test" },
      }),
      [401],
    );
  });
});
