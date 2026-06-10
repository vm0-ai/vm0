import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface CreatedAgent extends Actor {
  readonly agentId: string;
}

interface CreatedSkill extends Actor {
  readonly name: string;
}

interface CreatedCompose extends Actor {
  readonly composeId: string;
}

interface TestComposeContent {
  readonly version: string;
  readonly agents: Record<string, { readonly framework: "claude-code" }>;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function teamClient() {
  return setupApp({ context })(zeroTeamContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function skillsClient() {
  return setupApp({ context })(zeroSkillsCollectionContract);
}

function skillByNameClient() {
  return setupApp({ context })(zeroSkillsDetailContract);
}

function composeCreateClient() {
  return setupApp({ context })(composesMainContract);
}

function composeByIdClient() {
  return setupApp({ context })(zeroComposesByIdContract);
}

function actor(): Actor {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
}

function composeContent(name: string): TestComposeContent {
  return {
    version: "1.0",
    agents: {
      [name]: { framework: "claude-code" },
    },
  };
}

async function createSkill(args: {
  readonly actor: Actor;
  readonly name: string;
}): Promise<CreatedSkill> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  const response = await accept(
    skillsClient().create({
      headers: authHeaders(),
      body: {
        name: args.name,
        displayName: args.name,
        description: `${args.name} description`,
        files: [{ path: "SKILL.md", content: `# ${args.name}\n` }],
      },
    }),
    [201],
  );

  const skill = { ...args.actor, name: response.body.name };
  return await trackSkill(Promise.resolve(skill));
}

async function deleteSkill(skill: CreatedSkill): Promise<void> {
  mocks.clerk.session(skill.userId, skill.orgId);
  await accept(
    skillByNameClient().delete({
      headers: authHeaders(),
      params: { name: skill.name },
    }),
    [204, 404],
  );
}

async function createAgent(args: {
  readonly actor: Actor;
  readonly displayName: string;
  readonly description?: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly customSkills?: readonly string[];
  readonly visibility?: "public" | "private";
}): Promise<CreatedAgent> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: {
        displayName: args.displayName,
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
        ...(args.sound !== undefined ? { sound: args.sound } : {}),
        ...(args.avatarUrl !== undefined ? { avatarUrl: args.avatarUrl } : {}),
        ...(args.customSkills !== undefined
          ? { customSkills: [...args.customSkills] }
          : {}),
        ...(args.visibility !== undefined
          ? { visibility: args.visibility }
          : {}),
      },
    }),
    [201],
  );

  const agent = { ...args.actor, agentId: response.body.agentId };
  return await trackAgent(Promise.resolve(agent));
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  mocks.clerk.session(agent.userId, agent.orgId);
  await accept(
    agentByIdClient().delete({
      headers: authHeaders(),
      params: { id: agent.agentId },
    }),
    [204, 404],
  );
}

async function createRawCompose(actorRef: Actor): Promise<CreatedCompose> {
  mocks.clerk.session(actorRef.userId, actorRef.orgId);
  const response = await accept(
    composeCreateClient().create({
      headers: authHeaders(),
      body: { content: composeContent(`raw-${randomUUID().slice(0, 8)}`) },
    }),
    [201],
  );

  const compose = { ...actorRef, composeId: response.body.composeId };
  return await trackRawCompose(Promise.resolve(compose));
}

async function deleteRawCompose(compose: CreatedCompose): Promise<void> {
  mocks.clerk.session(compose.userId, compose.orgId);
  mocks.s3.listObjects([]);
  await accept(
    composeByIdClient().delete({
      headers: authHeaders(),
      params: { id: compose.composeId },
    }),
    [204, 404],
  );
}

function createTeamCleanupTracker(): {
  readonly trackAgent: (
    fixturePromise: Promise<CreatedAgent>,
  ) => Promise<CreatedAgent>;
  readonly trackRawCompose: (
    fixturePromise: Promise<CreatedCompose>,
  ) => Promise<CreatedCompose>;
  readonly trackSkill: (
    fixturePromise: Promise<CreatedSkill>,
  ) => Promise<CreatedSkill>;
} {
  const trackedAgents: CreatedAgent[] = [];
  const trackedRawComposes: CreatedCompose[] = [];
  const trackedSkills: CreatedSkill[] = [];

  afterEach(async () => {
    while (trackedRawComposes.length > 0) {
      const compose = trackedRawComposes.pop();
      if (compose !== undefined) {
        await deleteRawCompose(compose);
      }
    }
    while (trackedAgents.length > 0) {
      const agent = trackedAgents.pop();
      if (agent !== undefined) {
        await deleteAgent(agent);
      }
    }
    while (trackedSkills.length > 0) {
      const skill = trackedSkills.pop();
      if (skill !== undefined) {
        await deleteSkill(skill);
      }
    }
  });

  return {
    trackAgent: async (
      fixturePromise: Promise<CreatedAgent>,
    ): Promise<CreatedAgent> => {
      const fixture = await fixturePromise;
      trackedAgents.push(fixture);
      return fixture;
    },
    trackRawCompose: async (
      fixturePromise: Promise<CreatedCompose>,
    ): Promise<CreatedCompose> => {
      const fixture = await fixturePromise;
      trackedRawComposes.push(fixture);
      return fixture;
    },
    trackSkill: async (
      fixturePromise: Promise<CreatedSkill>,
    ): Promise<CreatedSkill> => {
      const fixture = await fixturePromise;
      trackedSkills.push(fixture);
      return fixture;
    },
  };
}

const { trackAgent, trackRawCompose, trackSkill } = createTeamCleanupTracker();

describe("/api/zero/team BDD", () => {
  it("requires authentication and an active organization, then lists an empty team", async () => {
    const client = teamClient();

    const unauthenticated = await accept(client.list({ headers: {} }), [401]);

    expect(unauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(client.list({ headers: authHeaders() }), [403]);

    expect(noOrg.body).toStrictEqual({
      error: {
        message: "No active organization. Please select an org.",
        code: "FORBIDDEN",
      },
    });

    const empty = actor();
    mocks.clerk.session(empty.userId, empty.orgId);
    const emptyList = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(emptyList.body).toStrictEqual([]);
  });

  it("lists public agents and owned private agents while excluding other orgs, other private agents, and raw composes", async () => {
    const owner = actor();
    const otherOwner = { userId: `user_${randomUUID()}`, orgId: owner.orgId };
    const otherOrg = actor();
    await createSkill({ actor: owner, name: "research-kit" });
    await createSkill({ actor: owner, name: "draft-helper" });

    await createAgent({
      actor: owner,
      displayName: "team-agent",
      description: "team description",
      sound: "ding",
      avatarUrl: "https://example.com/avatar.png",
    });
    await createAgent({
      actor: owner,
      displayName: "research-agent",
      customSkills: ["research-kit", "draft-helper"],
    });
    await createAgent({
      actor: owner,
      displayName: "owned-private-agent",
      visibility: "private",
    });
    const otherPrivate = await createAgent({
      actor: otherOwner,
      displayName: "other-private-agent",
      visibility: "private",
    });
    const otherOrgAgent = await createAgent({
      actor: otherOrg,
      displayName: "other-org-agent",
    });
    const rawCompose = await createRawCompose(owner);

    mocks.clerk.session(owner.userId, owner.orgId);
    const response = await accept(
      teamClient().list({ headers: authHeaders() }),
      [200],
    );

    const displayNames = response.body.map((agent) => {
      return agent.displayName;
    });
    expect(displayNames).toContain("team-agent");
    expect(displayNames).toContain("research-agent");
    expect(displayNames).toContain("owned-private-agent");
    expect(displayNames).not.toContain("other-private-agent");
    expect(displayNames).not.toContain("other-org-agent");

    const detailed = response.body.find((agent) => {
      return agent.displayName === "team-agent";
    });
    expect(detailed).toMatchObject({
      ownerId: owner.userId,
      description: "team description",
      sound: "ding",
      avatarUrl: "https://example.com/avatar.png",
      customSkills: [],
      visibility: "public",
      headVersionId: expect.any(String),
    });

    const skillAgent = response.body.find((agent) => {
      return agent.displayName === "research-agent";
    });
    expect(skillAgent?.customSkills).toStrictEqual([
      "research-kit",
      "draft-helper",
    ]);

    const ids = response.body.map((agent) => {
      return agent.id;
    });
    expect(ids).not.toContain(otherPrivate.agentId);
    expect(ids).not.toContain(otherOrgAgent.agentId);
    expect(ids).not.toContain(rawCompose.composeId);
  });
});
