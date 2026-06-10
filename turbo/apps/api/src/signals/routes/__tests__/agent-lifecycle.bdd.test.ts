import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the zero-agent lifecycle. Every precondition
// (Given) and verification (Then) is a real HTTP request through the app — no
// database seeding, no database row assertions. See `api.bdd.md` (CHAIN-AGENT)
// for the migration plan and the legacy cases this replaces.
const context = testContext();

describe("agent lifecycle (API-first BDD)", () => {
  it("chain-agent: creates, reads, lists, updates, then deletes an agent", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const admin = api.actAsAdmin();

    // Given a custom skill exists, created through the public skills API.
    await accept(
      api.skills.create({
        headers: SESSION_AUTH,
        body: {
          name: "research-notes",
          files: [{ path: "SKILL.md", content: "# Research notes" }],
        },
      }),
      [201],
    );

    // When the admin creates an agent that enables that skill.
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: {
          displayName: "Research Agent",
          description: "Tracks research context",
          sound: "calm",
          avatarUrl: "preset:2",
          customSkills: ["research-notes"],
        },
      }),
      [201],
    );

    // Then the response describes the freshly created agent.
    expect(created.body).toMatchObject({
      ownerId: admin.userId,
      displayName: "Research Agent",
      description: "Tracks research context",
      sound: "calm",
      avatarUrl: "preset:2",
      customSkills: ["research-notes"],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
    const agentId = created.body.agentId;
    expect(agentId).toStrictEqual(expect.any(String));

    // Then it is observable through GET by id.
    const fetched = await accept(
      api.agentsById.get({ params: { id: agentId }, headers: SESSION_AUTH }),
      [200],
    );
    expect(fetched.body).toMatchObject({
      agentId,
      displayName: "Research Agent",
      customSkills: ["research-notes"],
      visibility: "public",
    });

    // Then it appears in the org's agent list.
    const listed = await accept(
      api.agents.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.map((agent) => {
        return agent.agentId;
      }),
    ).toContain(agentId);

    // When the admin patches metadata only.
    const patched = await accept(
      api.agentsById.updateMetadata({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { displayName: "Renamed", description: "Updated description" },
      }),
      [200],
    );
    // Then the changed fields update while omitted fields are preserved.
    expect(patched.body).toMatchObject({
      displayName: "Renamed",
      description: "Updated description",
      sound: "calm",
      avatarUrl: "preset:2",
      customSkills: ["research-notes"],
      visibility: "public",
    });

    // When the admin replaces the agent via a full update that drops skills.
    const replaced = await accept(
      api.agentsById.update({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { displayName: "Replaced", customSkills: [] },
      }),
      [200],
    );
    // Then the update is reflected and the stale model fields stay cleared.
    expect(replaced.body).toMatchObject({
      displayName: "Replaced",
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });

    // Then a follow-up GET shows the latest state.
    const refetched = await accept(
      api.agentsById.get({ params: { id: agentId }, headers: SESSION_AUTH }),
      [200],
    );
    expect(refetched.body).toMatchObject({
      displayName: "Replaced",
      customSkills: [],
    });

    // When the owner deletes the agent.
    await accept(
      api.agentsById.delete({ params: { id: agentId }, headers: SESSION_AUTH }),
      [204],
    );

    // Then it is gone from both GET and the list.
    await accept(
      api.agentsById.get({ params: { id: agentId }, headers: SESSION_AUTH }),
      [404],
    );
    const afterDelete = await accept(
      api.agents.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      afterDelete.body.map((agent) => {
        return agent.agentId;
      }),
    ).not.toContain(agentId);
  });

  it("chain-agent-limit: enforces the public agent cap and frees a slot on delete", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Given the org has created the maximum number of public agents.
    const publicIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const created = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { displayName: `Public ${index + 1}` },
        }),
        [201],
      );
      expect(created.body.visibility).toBe("public");
      publicIds.push(created.body.agentId);
    }

    // When an 8th public agent is requested. Then the cap is enforced.
    const blocked = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Over the limit" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(blocked.body.error.message).toContain(
      "maximum number of agents (7)",
    );

    // When a private agent is requested. Then it is exempt from the cap.
    const privateAgent = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Private", visibility: "private" },
      }),
      [201],
    );
    expect(privateAgent.body.visibility).toBe("private");

    // When the owner promotes that private agent to public. Then the cap
    // blocks the transition too.
    const promoted = await accept(
      api.agentsById.updateMetadata({
        params: { id: privateAgent.body.agentId },
        headers: SESSION_AUTH,
        body: { visibility: "public" },
      }),
      [409],
    );
    expect(promoted.body.error.code).toBe("CONFLICT");

    // When an existing public agent is deleted. Then a slot frees up and a new
    // public agent can be created.
    const freedId = publicIds[0];
    if (!freedId) {
      throw new Error("expected a created public agent");
    }
    await accept(
      api.agentsById.delete({ params: { id: freedId }, headers: SESSION_AUTH }),
      [204],
    );
    const afterDelete = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "After delete" },
      }),
      [201],
    );
    expect(afterDelete.body.visibility).toBe("public");
  });

  it("chain-agent-visibility: hides private agents from non-owners in the same org", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;
    const owner = api.actAsMember({ userId: `user_${randomUUID()}`, orgId });

    // Given a member owns a private agent.
    const created = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Private agent", visibility: "private" },
      }),
      [201],
    );
    const agentId = created.body.agentId;

    // When a different member of the same org reads it. Then it is hidden.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await accept(
      api.agentsById.get({ params: { id: agentId }, headers: SESSION_AUTH }),
      [404],
    );
    const otherList = await accept(
      api.agents.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      otherList.body.map((agent) => {
        return agent.agentId;
      }),
    ).not.toContain(agentId);

    // Then the owner can still read their own private agent.
    api.actAsMember({ userId: owner.userId, orgId });
    const ownerView = await accept(
      api.agentsById.get({ params: { id: agentId }, headers: SESSION_AUTH }),
      [200],
    );
    expect(ownerView.body.visibility).toBe("private");
  });

  describe("write permissions", () => {
    it("lets an org admin manage another member's public agent but not its visibility", async () => {
      const api = createBddApi(context);
      api.allowInstructionsStorage();
      const orgId = `org_${randomUUID()}`;
      api.actAsMember({ userId: `user_${randomUUID()}`, orgId });

      // Given a member owns a public agent.
      const created = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { displayName: "Member public" },
        }),
        [201],
      );
      const agentId = created.body.agentId;

      // When an admin (not the owner) patches its metadata. Then it succeeds.
      api.actAsAdmin({ userId: `user_${randomUUID()}`, orgId });
      const patched = await accept(
        api.agentsById.updateMetadata({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { displayName: "Admin renamed" },
        }),
        [200],
      );
      expect(patched.body.displayName).toBe("Admin renamed");

      // When the admin tries to change visibility. Then only the owner may.
      const visibility = await accept(
        api.agentsById.updateMetadata({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { visibility: "private" },
        }),
        [403],
      );
      expect(visibility.body.error.message).toBe(
        "Only the agent owner can update agent visibility",
      );

      // Then the admin can delete the public agent.
      await accept(
        api.agentsById.delete({
          params: { id: agentId },
          headers: SESSION_AUTH,
        }),
        [204],
      );
    });

    it("blocks a non-owner member from updating or deleting another member's agent", async () => {
      const api = createBddApi(context);
      api.allowInstructionsStorage();
      const orgId = `org_${randomUUID()}`;
      api.actAsMember({ userId: `user_${randomUUID()}`, orgId });

      const created = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { displayName: "Owned by member" },
        }),
        [201],
      );
      const agentId = created.body.agentId;

      // When a different member acts on it. Then every write is forbidden.
      api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
      const put = await accept(
        api.agentsById.update({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { displayName: "Nope" },
        }),
        [403],
      );
      expect(put.body.error.message).toBe(
        "Only the agent owner or org admin can update agent configuration",
      );
      const patch = await accept(
        api.agentsById.updateMetadata({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { displayName: "Nope" },
        }),
        [403],
      );
      expect(patch.body.error.message).toBe(
        "Only the agent owner or org admin can update agent profile",
      );
      const remove = await accept(
        api.agentsById.delete({
          params: { id: agentId },
          headers: SESSION_AUTH,
        }),
        [403],
      );
      expect(remove.body.error.message).toBe(
        "Only the agent owner or org admin can delete agent",
      );
    });

    it("blocks an org admin from touching another member's private agent", async () => {
      const api = createBddApi(context);
      api.allowInstructionsStorage();
      const orgId = `org_${randomUUID()}`;
      api.actAsMember({ userId: `user_${randomUUID()}`, orgId });

      const created = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { displayName: "Private owned", visibility: "private" },
        }),
        [201],
      );
      const agentId = created.body.agentId;

      api.actAsAdmin({ userId: `user_${randomUUID()}`, orgId });
      const patch = await accept(
        api.agentsById.updateMetadata({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { displayName: "Nope" },
        }),
        [403],
      );
      expect(patch.body.error.message).toBe(
        "Only the private agent owner can update agent profile",
      );
      const put = await accept(
        api.agentsById.update({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { displayName: "Nope" },
        }),
        [403],
      );
      expect(put.body.error.message).toBe(
        "Only the private agent owner can update agent configuration",
      );
      const remove = await accept(
        api.agentsById.delete({
          params: { id: agentId },
          headers: SESSION_AUTH,
        }),
        [403],
      );
      expect(remove.body.error.message).toBe(
        "Only the private agent owner can delete agent",
      );
    });
  });

  describe("custom skill validation", () => {
    it("rejects unknown and built-in custom skills on create and update", async () => {
      const api = createBddApi(context);
      api.allowInstructionsStorage();
      api.actAsAdmin();

      // When creating with an unknown skill. Then it is rejected.
      const missingOnCreate = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { customSkills: ["missing-skill"] },
        }),
        [400],
      );
      expect(missingOnCreate.body.error.message).toBe(
        "Custom skill 'missing-skill' not found in this organization. Create it with 'zero skill create' first.",
      );

      // When creating with a built-in connector name. Then it is rejected.
      const builtInOnCreate = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { customSkills: ["github"] },
        }),
        [400],
      );
      expect(builtInOnCreate.body.error.message).toBe(
        "'github' is a built-in connector, not a custom skill. Enable it via connectors instead.",
      );

      // Given a real agent exists.
      const created = await accept(
        api.agents.create({
          headers: SESSION_AUTH,
          body: { displayName: "Skill target" },
        }),
        [201],
      );
      const agentId = created.body.agentId;

      // When updating with an unknown skill. Then it is rejected.
      const missingOnUpdate = await accept(
        api.agentsById.update({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { customSkills: ["missing-skill"] },
        }),
        [400],
      );
      expect(missingOnUpdate.body.error.message).toBe(
        "Custom skill 'missing-skill' not found in this organization. Create it with 'zero skill create' first.",
      );

      // When updating with a built-in connector name. Then it is rejected.
      const builtInOnUpdate = await accept(
        api.agentsById.update({
          params: { id: agentId },
          headers: SESSION_AUTH,
          body: { customSkills: ["github"] },
        }),
        [400],
      );
      expect(builtInOnUpdate.body.error.message).toBe(
        "'github' is a built-in connector, not a custom skill. Enable it via connectors instead.",
      );
    });
  });

  describe("authorization", () => {
    it("rejects unauthenticated requests on every agent route", async () => {
      const api = createBddApi(context);
      const id = randomUUID();

      const create = await accept(
        api.agents.create({ headers: {}, body: {} }),
        [401],
      );
      expect(create.body.error).toStrictEqual({
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      });
      await accept(api.agents.list({ headers: {} }), [401]);
      await accept(api.agentsById.get({ params: { id }, headers: {} }), [401]);
      await accept(
        api.agentsById.update({ params: { id }, headers: {}, body: {} }),
        [401],
      );
      await accept(
        api.agentsById.updateMetadata({
          params: { id },
          headers: {},
          body: {},
        }),
        [401],
      );
      await accept(
        api.agentsById.delete({ params: { id }, headers: {} }),
        [401],
      );
    });

    it("rejects sessions without an active organization", async () => {
      const api = createBddApi(context);
      api.actAsNoOrg();

      await accept(
        api.agents.create({ headers: SESSION_AUTH, body: {} }),
        [401],
      );
      await accept(api.agents.list({ headers: SESSION_AUTH }), [401]);
    });

    it("rejects zero tokens missing the required capability", async () => {
      const api = createBddApi(context);
      const id = randomUUID();

      const create = await accept(
        api.agents.create({
          headers: api.zeroAuth(["agent:read"]),
          body: {},
        }),
        [403],
      );
      expect(create.body.error.message).toBe(
        "Missing required capability: agent:write",
      );
      const get = await accept(
        api.agentsById.get({
          params: { id },
          headers: api.zeroAuth(["file:read"]),
        }),
        [403],
      );
      expect(get.body.error.message).toBe(
        "Missing required capability: agent:read",
      );
      const update = await accept(
        api.agentsById.update({
          params: { id },
          headers: api.zeroAuth(["agent:read"]),
          body: {},
        }),
        [403],
      );
      expect(update.body.error.message).toBe(
        "Missing required capability: agent:write",
      );
      const remove = await accept(
        api.agentsById.delete({
          params: { id },
          headers: api.zeroAuth(["agent:read"]),
        }),
        [403],
      );
      expect(remove.body.error.message).toBe(
        "Missing required capability: agent:delete",
      );
    });

    it("validates path params and reports missing agents", async () => {
      const api = createBddApi(context);
      api.actAsAdmin();
      const unknownId = randomUUID();

      await accept(
        api.agentsById.get({
          params: { id: "not-a-uuid" },
          headers: SESSION_AUTH,
        }),
        [400],
      );
      await accept(
        api.agentsById.get({
          params: { id: unknownId },
          headers: SESSION_AUTH,
        }),
        [404],
      );
      await accept(
        api.agentsById.update({
          params: { id: unknownId },
          headers: SESSION_AUTH,
          body: { displayName: "x" },
        }),
        [404],
      );
      await accept(
        api.agentsById.updateMetadata({
          params: { id: unknownId },
          headers: SESSION_AUTH,
          body: { displayName: "x" },
        }),
        [404],
      );
      await accept(
        api.agentsById.delete({
          params: { id: unknownId },
          headers: SESSION_AUTH,
        }),
        [404],
      );
    });
  });
});
