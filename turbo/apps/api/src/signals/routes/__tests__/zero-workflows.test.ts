import { randomUUID } from "node:crypto";

import {
  zeroWorkflowAgentsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  zeroWorkflowAgents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteSkillsForFixture$,
  mockSkillContent,
  seedAgentForInstructions$,
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

function collectionClient() {
  return setupApp({ context })(zeroWorkflowsCollectionContract);
}

function detailClient() {
  return setupApp({ context })(zeroWorkflowsDetailContract);
}

function agentsClient() {
  return setupApp({ context })(zeroWorkflowAgentsContract);
}

function workflowFiles(content: string) {
  return [{ path: "SKILL.md", content }];
}

describe("zero workflows", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  it("creates private workflows by default and hides them from other org members", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          name: "owner-workflow",
          displayName: "Owner Workflow",
          files: workflowFiles("# owner workflow"),
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      name: "owner-workflow",
      displayName: "Owner Workflow",
      visibility: "private",
      ownerUserId: fixture.userId,
      attachedAgentCount: 0,
      attachedAgents: [],
      canManage: true,
    });

    const ownerList = await accept(
      collectionClient().list({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      ownerList.body.map((workflow) => {
        return workflow.name;
      }),
    ).toContain("owner-workflow");

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");
    const otherList = await accept(
      collectionClient().list({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      otherList.body.map((workflow) => {
        return workflow.name;
      }),
    ).not.toContain("owner-workflow");
  });

  it("requires admin permission to create public workflows", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    context.mocks.s3.send.mockResolvedValue({});

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const rejected = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          name: "public-workflow",
          visibility: "public",
          files: workflowFiles("# public workflow"),
        },
      }),
      [403],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message: "Only org admins can create public workflows",
        code: "FORBIDDEN",
      },
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const created = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          name: "public-workflow",
          visibility: "public",
          files: workflowFiles("# public workflow"),
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      name: "public-workflow",
      visibility: "public",
      canManage: true,
    });

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");
    const memberList = await accept(
      collectionClient().list({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(memberList.body).toContainEqual(
      expect.objectContaining({
        name: "public-workflow",
        visibility: "public",
        canManage: false,
      }),
    );
  });

  it("attaches private workflows to public agents for the workflow owner only", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const agentOwnerId = `user_${randomUUID()}`;
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: agentOwnerId,
        displayName: "Workflow Agent",
        visibility: "public",
      },
      context.signal,
    );
    const privateAgent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: agentOwnerId,
        displayName: "Private Workflow Agent",
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});

    await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          name: "private-agent-workflow",
          files: workflowFiles("# private agent workflow"),
        },
      }),
      [201],
    );

    const privateAgentRejected = await accept(
      agentsClient().attach({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
        body: { agentId: privateAgent.agentId },
      }),
      [403],
    );
    expect(privateAgentRejected.body).toStrictEqual({
      error: {
        message:
          "Only the private agent owner can attach workflow to this agent",
        code: "FORBIDDEN",
      },
    });

    const attached = await accept(
      agentsClient().attach({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
        body: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(attached.body).toMatchObject({
      name: "private-agent-workflow",
      attachedAgentCount: 1,
      attachedAgents: [
        expect.objectContaining({
          agentId: agent.agentId,
          displayName: "Workflow Agent",
        }),
      ],
    });

    const listedAgents = await accept(
      agentsClient().list({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
      }),
      [200],
    );
    expect(listedAgents.body).toHaveLength(1);
    expect(listedAgents.body[0]?.agentId).toBe(agent.agentId);

    const detached = await accept(
      agentsClient().detach({
        headers: authHeaders(),
        params: {
          name: "private-agent-workflow",
          agentId: agent.agentId,
        },
      }),
      [200],
    );
    expect(detached.body.attachedAgentCount).toBe(0);

    const setAttached = await accept(
      agentsClient().set({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
        body: { agentIds: [agent.agentId] },
      }),
      [200],
    );
    expect(setAttached.body.attachedAgentCount).toBe(1);

    const setDetached = await accept(
      agentsClient().set({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
        body: { agentIds: [] },
      }),
      [200],
    );
    expect(setDetached.body.attachedAgentCount).toBe(0);

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");
    const hidden = await accept(
      agentsClient().list({
        headers: authHeaders(),
        params: { name: "private-agent-workflow" },
      }),
      [404],
    );
    expect(hidden.body).toStrictEqual({
      error: {
        message: "Workflow not found: private-agent-workflow",
        code: "NOT_FOUND",
      },
    });
  });

  it("reads workflow content from the existing skill volume storage", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const workflowName = "content-workflow";
    const s3Key = "test-workflows/content-workflow";
    await store.set(
      seedSkill$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: workflowName,
        displayName: "Content Workflow",
        description: "Workflow content test",
      },
      context.signal,
    );
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName: workflowName,
        s3Key,
        headVersionId: randomUUID(),
      },
      context.signal,
    );
    mockSkillContent(context, {
      s3Key,
      content: "# Content workflow\n",
      extraFiles: [{ path: "notes.md", content: "details" }],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: workflowName },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      name: workflowName,
      displayName: "Content Workflow",
      description: "Workflow content test",
      visibility: "public",
      content: "# Content workflow\n",
      files: [
        { path: "SKILL.md", size: "# Content workflow\n".length },
        { path: "notes.md", size: "details".length },
      ],
      fileContents: [
        { path: "SKILL.md", content: "# Content workflow\n" },
        { path: "notes.md", content: "details" },
      ],
    });
  });

  it("deletes workflows and cascades agent attachments", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const workflowName = "delete-workflow";
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        customSkills: [workflowName],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const deleted = await accept(
      detailClient().delete({
        headers: authHeaders(),
        params: { name: workflowName },
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    const db = store.set(writeDb$);
    const workflows = await db
      .select({ id: zeroWorkflows.id })
      .from(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, fixture.orgId),
          eq(zeroWorkflows.name, workflowName),
        ),
      );
    const attachments = await db
      .select({ id: zeroWorkflowAgents.id })
      .from(zeroWorkflowAgents)
      .where(
        and(
          eq(zeroWorkflowAgents.orgId, fixture.orgId),
          eq(zeroWorkflowAgents.agentId, agent.agentId),
        ),
      );
    expect(workflows).toHaveLength(0);
    expect(attachments).toHaveLength(0);
  });
});
