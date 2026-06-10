import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the team listing (`GET /api/zero/team`), which
// returns the agents/composes visible in the caller's active org. Every member
// and agent is built through the public agents/skills API. The "compose without
// zero-agent metadata" exclusion is a SQL join filter with no API surface to
// create such a row (GAP-STANDALONE-COMPOSE); it carries no unique JS branch and
// is a drop decision. See `api.bdd.md` (CHAIN-TEAM).
const context = testContext();

async function createAgent(
  api: ReturnType<typeof createBddApi>,
  body: {
    readonly displayName: string;
    readonly description?: string;
    readonly sound?: string;
    readonly avatarUrl?: string;
    readonly customSkills?: string[];
    readonly visibility?: "public" | "private";
  },
): Promise<string> {
  const created = await accept(
    api.agents.create({ headers: SESSION_AUTH, body }),
    [201],
  );
  return created.body.agentId;
}

describe("team listing (API-first BDD)", () => {
  it("lists the org's agents with their fields and custom skills", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const admin = api.actAsAdmin();

    // Then a fresh org has an empty team.
    const empty = await accept(api.team.list({ headers: SESSION_AUTH }), [200]);
    expect(empty.body).toStrictEqual([]);

    // Given two skills and an agent that enables them.
    for (const name of ["research-kit", "draft-helper"]) {
      await accept(
        api.skills.create({
          headers: SESSION_AUTH,
          body: { name, files: [{ path: "SKILL.md", content: `# ${name}` }] },
        }),
        [201],
      );
    }
    const agentId = await createAgent(api, {
      displayName: "team-agent",
      description: "team description",
      sound: "ding",
      avatarUrl: "https://example.com/avatar.png",
      customSkills: ["research-kit", "draft-helper"],
    });

    // Then the team lists that agent with its full metadata.
    const listed = await accept(
      api.team.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: agentId,
      ownerId: admin.userId,
      displayName: "team-agent",
      description: "team description",
      sound: "ding",
      avatarUrl: "https://example.com/avatar.png",
      customSkills: ["research-kit", "draft-helper"],
      visibility: "public",
    });
    expect(listed.body[0]?.headVersionId).toStrictEqual(expect.any(String));
    expect(listed.body[0]?.updatedAt).toStrictEqual(expect.any(String));
  });

  it("scopes the team to the active org and filters private agents by owner", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;
    const me = api.actAsAdmin({ orgId });

    // I own a public and a private agent.
    await createAgent(api, { displayName: "public-agent" });
    await createAgent(api, {
      displayName: "owned-private-agent",
      visibility: "private",
    });

    // Another member of the same org owns a public and a private agent.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await createAgent(api, { displayName: "other-public-agent" });
    const otherPrivateId = await createAgent(api, {
      displayName: "other-private-agent",
      visibility: "private",
    });

    // A different org owns an agent that must not leak.
    api.actAsAdmin({ orgId: `org_${randomUUID()}` });
    const foreignId = await createAgent(api, { displayName: "foreign-agent" });

    // The team (as me) is every public agent plus my own private agent.
    api.actAsAdmin({ userId: me.userId, orgId });
    const team = await accept(api.team.list({ headers: SESSION_AUTH }), [200]);
    const names = team.body.map((agent) => {
      return agent.displayName;
    });
    expect(new Set(names)).toStrictEqual(
      new Set(["public-agent", "owned-private-agent", "other-public-agent"]),
    );
    const ids = team.body.map((agent) => {
      return agent.id;
    });
    expect(ids).not.toContain(otherPrivateId);
    expect(ids).not.toContain(foreignId);
  });

  it("rejects unauthenticated and organization-less requests", async () => {
    const api = createBddApi(context);

    const unauthenticated = await accept(api.team.list({ headers: {} }), [401]);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    api.actAsNoOrg();
    const noOrg = await accept(api.team.list({ headers: SESSION_AUTH }), [403]);
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "No active organization. Please select an org.",
        code: "FORBIDDEN",
      },
    });
  });
});
