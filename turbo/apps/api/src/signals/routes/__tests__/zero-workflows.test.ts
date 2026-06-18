import { randomUUID } from "node:crypto";

import {
  zeroWorkflowAgentsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import {
  zeroWorkflowAgents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteWorkflowsForFixture$,
  mockMissingWorkflowContent,
  mockWorkflowContent,
  seedAgentForInstructions$,
  seedWorkflow$,
  seedWorkflowStorage$,
  seedWorkflowsFixture$,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandName(command: unknown): string {
  if (!isRecord(command)) {
    return "";
  }
  return command.constructor.name;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (!isRecord(command) || !isRecord(command.input)) {
    return {};
  }
  return command.input;
}

function deleteObjectKeys(command: unknown): string[] {
  const input = commandInput(command);
  const deletePayload = input.Delete;
  if (!isRecord(deletePayload) || !Array.isArray(deletePayload.Objects)) {
    return [];
  }
  return deletePayload.Objects.flatMap((object) => {
    if (!isRecord(object) || typeof object.Key !== "string") {
      return [];
    }
    return [object.Key];
  });
}

function workflowFiles(content: string) {
  return [{ path: "SKILL.md", content }];
}

describe("zero workflows", () => {
  const track = createFixtureTracker<WorkflowsFixture>((fixture) => {
    return store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("creates private workflows by default and hides them from other org members", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
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
      store.set(seedWorkflowsFixture$, undefined, context.signal),
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
      store.set(seedWorkflowsFixture$, undefined, context.signal),
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
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const workflowName = "content-workflow";
    const s3Key = "test-workflows/content-workflow";
    await store.set(
      seedWorkflow$,
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
      seedWorkflowStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowName: workflowName,
        s3Key,
        headVersionId: randomUUID(),
      },
      context.signal,
    );
    mockWorkflowContent(context, {
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

  it("returns workflow metadata when backing storage objects are missing", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const workflowName = "dangling-workflow";
    const s3Key = "test-workflows/dangling-workflow";
    await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: workflowName,
        displayName: "Dangling Workflow",
      },
      context.signal,
    );
    await store.set(
      seedWorkflowStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowName,
        s3Key,
        headVersionId: randomUUID(),
      },
      context.signal,
    );
    mockMissingWorkflowContent(context, { s3Key });
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
      displayName: "Dangling Workflow",
      content: null,
      files: null,
      fileContents: null,
    });
  });

  it("deletes workflow storage using a slash-bounded prefix", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const deletedWorkflowName = "posthog";
    const keptWorkflowName = "posthog-tracking";
    const deletedPrefix = `orgs/${fixture.orgId}/${getCustomSkillStorageName(
      deletedWorkflowName,
    )}`;
    const keptPrefix = `orgs/${fixture.orgId}/${getCustomSkillStorageName(
      keptWorkflowName,
    )}`;
    const deletedKeys = [
      `${deletedPrefix}/version/archive.tar.gz`,
      `${deletedPrefix}/version/manifest.json`,
    ];
    const allKeys = [
      ...deletedKeys,
      `${keptPrefix}/version/archive.tar.gz`,
      `${keptPrefix}/version/manifest.json`,
    ];

    await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: deletedWorkflowName,
      },
      context.signal,
    );
    await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: keptWorkflowName,
      },
      context.signal,
    );
    await store.set(
      seedWorkflowStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowName: deletedWorkflowName,
        s3Key: `${deletedPrefix}/version`,
        headVersionId: randomUUID(),
      },
      context.signal,
    );
    await store.set(
      seedWorkflowStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowName: keptWorkflowName,
        s3Key: `${keptPrefix}/version`,
        headVersionId: randomUUID(),
      },
      context.signal,
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "ListObjectsV2Command") {
        const prefix = commandInput(command).Prefix;
        if (typeof prefix !== "string") {
          return Promise.resolve({ Contents: [] });
        }
        return Promise.resolve({
          Contents: allKeys
            .filter((key) => {
              return key.startsWith(prefix);
            })
            .map((key) => {
              return {
                Key: key,
                Size: 1,
                LastModified: new Date("2026-06-18T00:00:00.000Z"),
              };
            }),
        });
      }
      return Promise.resolve({});
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await accept(
      detailClient().delete({
        headers: authHeaders(),
        params: { name: deletedWorkflowName },
      }),
      [204],
    );

    const listCommand = context.mocks.s3.send.mock.calls
      .map((call) => {
        return call[0];
      })
      .find((command) => {
        return commandName(command) === "ListObjectsV2Command";
      });
    expect(commandInput(listCommand).Prefix).toBe(`${deletedPrefix}/`);

    const deleteCommand = context.mocks.s3.send.mock.calls
      .map((call) => {
        return call[0];
      })
      .find((command) => {
        return commandName(command) === "DeleteObjectsCommand";
      });
    expect(deleteObjectKeys(deleteCommand)).toStrictEqual(deletedKeys);
  });

  it("deletes workflows and cascades agent attachments", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const workflowName = "delete-workflow";
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowNames: [workflowName],
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
