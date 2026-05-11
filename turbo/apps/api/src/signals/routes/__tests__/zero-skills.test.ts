import { randomUUID } from "node:crypto";

import {
  zeroAgentInstructionsContract,
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteSkillsForFixture$,
  mockInstructionsContent,
  mockSkillContent,
  seedAgentForInstructions$,
  seedInstructionsStorage$,
  seedSkill$,
  seedSkillStorage$,
  seedSkillsFixture$,
  type SkillsFixture,
} from "./helpers/zero-skills";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(zeroSkillsCollectionContract);
}

function detailClient() {
  return setupApp({ context })(zeroSkillsDetailContract);
}

function instructionsClient() {
  return setupApp({ context })(zeroAgentInstructionsContract);
}

describe("GET /api/zero/skills", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(listClient().list({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      listClient().list({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty array when no skills exist", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("returns all org skills", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "skill-one",
        displayName: "Skill One",
        description: "First skill",
      },
      context.signal,
    );
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "skill-two",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toHaveLength(2);
    const names = response.body.map((skill) => {
      return skill.name;
    });
    expect(names).toContain("skill-one");
    expect(names).toContain("skill-two");
  });

  it("allows org member to list skills", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "readable-skill",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      listClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.name).toBe("readable-skill");
  });
});

describe("GET /api/zero/skills/:name", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      detailClient().get({ headers: {}, params: { name: "any" } }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      detailClient().get({ headers: authHeaders(), params: { name: "any" } }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns skill detail with content", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const skillName = "my-skill";
    const s3Key = `orgs/${fixture.orgId}/custom-skill@${skillName}/v1`;
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: skillName,
        displayName: "My Skill",
      },
      context.signal,
    );
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName,
        s3Key,
        headVersionId: `head-${randomUUID()}`,
      },
      context.signal,
    );
    mockSkillContent(context, { s3Key, content: "# My Skill Content" });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: skillName },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      name: "my-skill",
      displayName: "My Skill",
      description: null,
      content: "# My Skill Content",
      files: [{ path: "SKILL.md", size: 18 }],
    });
  });

  it("returns file listing for a multi-file skill", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const skillName = "multi-skill";
    const s3Key = `orgs/${fixture.orgId}/custom-skill@${skillName}/v1`;
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: skillName,
      },
      context.signal,
    );
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName,
        s3Key,
        headVersionId: `head-${randomUUID()}`,
      },
      context.signal,
    );
    mockSkillContent(context, {
      s3Key,
      content: "# Multi",
      extraFiles: [{ path: "templates/prompt.md", size: 42 }],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: skillName },
      }),
      [200],
    );

    expect(response.body.files).toStrictEqual([
      { path: "SKILL.md", size: 7 },
      { path: "templates/prompt.md", size: 42 },
    ]);
    expect(response.body.content).toBe("# Multi");
  });

  it("ignores non-volume storage rows for skill content", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const skillName = "typed-skill";
    const s3Key = `orgs/${fixture.orgId}/custom-skill@${skillName}/non-volume`;
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: skillName,
        displayName: "Typed Skill",
      },
      context.signal,
    );
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName,
        s3Key,
        headVersionId: `head-${randomUUID()}`,
        type: "artifact",
      },
      context.signal,
    );
    mockSkillContent(context, {
      s3Key,
      content: "# Non-volume content",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: skillName },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      name: skillName,
      displayName: "Typed Skill",
      description: null,
      content: null,
      files: null,
    });
  });

  it("returns 404 for a non-existent skill", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: "no-such-skill" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Skill not found: no-such-skill", code: "NOT_FOUND" },
    });
  });

  it("allows org member to read skill detail", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const skillName = "readable-skill";
    const s3Key = `orgs/${fixture.orgId}/custom-skill@${skillName}/v1`;
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: skillName,
      },
      context.signal,
    );
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName,
        s3Key,
        headVersionId: `head-${randomUUID()}`,
      },
      context.signal,
    );
    mockSkillContent(context, { s3Key, content: "# Readable" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: skillName },
      }),
      [200],
    );

    expect(response.body.content).toBe("# Readable");
    expect(response.body.name).toBe("readable-skill");
  });
});

describe("GET /api/zero/agents/:id/instructions", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      instructionsClient().get({
        headers: {},
        params: { id: randomUUID() },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns null content when no instructions uploaded", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });
  });

  it("returns 404 for unknown agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const unknownAgentId = randomUUID();
    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: unknownAgentId },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${unknownAgentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("allows org member to read instructions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });
  });

  it("returns derived filename for compose-only agents", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
        withZeroAgent: false,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });
  });

  it("returns null filename when compose content cannot be parsed", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeContent: { version: "1" },
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ content: null, filename: null });
  });

  it("returns explicit compose instructions filename when no storage exists", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        instructions: "docs/CUSTOM.md",
        withComposeVersion: true,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: null,
      filename: "docs/CUSTOM.md",
    });
  });

  it("reads Claude instructions content and filename", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId, name } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@${name}/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: name,
        s3Key,
      },
      context.signal,
    );
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      content: "# Claude Instructions",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: "# Claude Instructions",
      filename: "CLAUDE.md",
    });
  });

  it("reads Codex instructions content and filename", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId, name } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        framework: "codex",
        withComposeVersion: true,
      },
      context.signal,
    );
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@${name}/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: name,
        s3Key,
      },
      context.signal,
    );
    mockInstructionsContent(context, {
      s3Key,
      filename: "AGENTS.md",
      content: "# Codex Instructions",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: "# Codex Instructions",
      filename: "AGENTS.md",
    });
  });

  it("returns empty string instructions content when uploaded file is empty", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId, name } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@${name}/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: name,
        s3Key,
      },
      context.signal,
    );
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      content: "",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: "",
      filename: "CLAUDE.md",
    });
  });

  it("returns derived filename when manifest lacks the instruction file", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId, name } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@${name}/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: name,
        s3Key,
      },
      context.signal,
    );
    mockInstructionsContent(context, {
      s3Key,
      filename: "README.md",
      content: "# Not Instructions",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });
  });

  it("strips legacy metadata from instructions content", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId, name } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        withComposeVersion: true,
      },
      context.signal,
    );
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@${name}/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: name,
        s3Key,
      },
      context.signal,
    );
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      content: "[AGENT_PROFILE]\nname: legacy\n[/AGENT_PROFILE]\n# Visible",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      instructionsClient().get({
        headers: authHeaders(),
        params: { id: agentId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      content: "# Visible",
      filename: "CLAUDE.md",
    });
  });
});
