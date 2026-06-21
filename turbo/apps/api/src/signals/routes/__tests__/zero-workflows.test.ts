import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
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

describe("zero workflows", () => {
  const track = createFixtureTracker<WorkflowsFixture>((fixture) => {
    return store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("creates private workflows by default and hides them from other org members", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    // The owning member creates a private agent so they hold write-permission.
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Owner Agent",
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          agentId: agent.agentId,
          name: "owner-workflow",
          displayName: "Owner Workflow",
          instruction: "# owner workflow",
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      name: "owner-workflow",
      displayName: "Owner Workflow",
      visibility: "private",
      ownerUserId: fixture.userId,
      agentId: agent.agentId,
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

  it("requires agent write-permission to create workflows under an agent", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    // A public agent owned by another user. Non-owner members cannot write to
    // it; org admins can.
    const agentOwnerId = `user_${randomUUID()}`;
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: agentOwnerId,
        displayName: "Public Agent",
        visibility: "public",
      },
      context.signal,
    );
    context.mocks.s3.send.mockResolvedValue({});

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const rejected = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          agentId: agent.agentId,
          name: "public-workflow",
          visibility: "public",
          instruction: "# public workflow",
        },
      }),
      [403],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can create workflows on this agent",
        code: "FORBIDDEN",
      },
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const created = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          agentId: agent.agentId,
          name: "public-workflow",
          visibility: "public",
          instruction: "# public workflow",
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

  it("copies a workflow onto another agent the caller can write, but not onto a private agent owned by someone else", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    // The caller owns a source agent (and its workflow) plus a public target
    // agent. A second user owns a private agent the caller cannot write.
    const sourceAgent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Source Agent",
        visibility: "private",
      },
      context.signal,
    );
    const targetAgent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Target Agent",
        visibility: "public",
      },
      context.signal,
    );
    const otherOwnerId = `user_${randomUUID()}`;
    const privateAgent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: otherOwnerId,
        displayName: "Private Agent",
        visibility: "private",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      collectionClient().create({
        headers: authHeaders(),
        body: {
          agentId: sourceAgent.agentId,
          name: "copyable-workflow",
          instruction: "# copyable workflow",
        },
      }),
      [201],
    );
    const workflowId = created.body.id;

    const privateRejected = await accept(
      detailClient().copy({
        headers: authHeaders(),
        params: { workflowId },
        body: { toAgentId: privateAgent.agentId },
      }),
      [403],
    );
    expect(privateRejected.body).toStrictEqual({
      error: {
        message:
          "Only the private agent owner can copy workflows onto this agent",
        code: "FORBIDDEN",
      },
    });

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(),
        params: { workflowId },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(copied.body).toMatchObject({
      name: "copyable-workflow",
      agentId: targetAgent.agentId,
      visibility: "private",
      ownerUserId: fixture.userId,
      canManage: true,
    });
    expect(copied.body.id).not.toBe(workflowId);

    // Both the original and the fork are now visible to the owner.
    const listed = await accept(
      collectionClient().list({
        headers: authHeaders(),
      }),
      [200],
    );
    const copyableAgentIds = listed.body
      .filter((workflow) => workflow.name === "copyable-workflow")
      .map((workflow) => workflow.agentId)
      .sort();
    expect(copyableAgentIds).toStrictEqual(
      [sourceAgent.agentId, targetAgent.agentId].sort(),
    );
  });

  it("reads workflow content from the existing skill volume storage", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Content Agent",
        visibility: "public",
      },
      context.signal,
    );
    const workflowName = "content-workflow";
    const s3Key = "test-workflows/content-workflow";
    const workflowId = await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agent.agentId,
        name: workflowName,
        instruction: "# Content workflow\n",
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
        workflowId,
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
        params: { workflowId },
      }),
      [200],
    );

    // The synthesized SKILL.md is never surfaced; the instruction is read from
    // the DB and only supplementary files are listed.
    expect(response.body).toMatchObject({
      name: workflowName,
      displayName: "Content Workflow",
      description: "Workflow content test",
      visibility: "public",
      instruction: "# Content workflow\n",
      files: [{ path: "notes.md", size: "details".length }],
      fileContents: [{ path: "notes.md", content: "details" }],
    });
  });

  it("returns workflow metadata when backing storage objects are missing", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Dangling Agent",
        visibility: "public",
      },
      context.signal,
    );
    const workflowName = "dangling-workflow";
    const s3Key = "test-workflows/dangling-workflow";
    const workflowId = await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agent.agentId,
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
        workflowId,
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
        params: { workflowId },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      name: workflowName,
      displayName: "Dangling Workflow",
      files: null,
      fileContents: null,
    });
  });

  it("deletes workflow storage using a slash-bounded prefix", async () => {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const agent = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Delete Prefix Agent",
        visibility: "public",
      },
      context.signal,
    );
    const deletedWorkflowName = "posthog";
    const keptWorkflowName = "posthog-tracking";
    const deletedWorkflowId = await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agent.agentId,
        name: deletedWorkflowName,
      },
      context.signal,
    );
    const keptWorkflowId = await store.set(
      seedWorkflow$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agent.agentId,
        name: keptWorkflowName,
      },
      context.signal,
    );
    const deletedPrefix = `orgs/${fixture.orgId}/${getCustomSkillStorageName(
      deletedWorkflowId,
    )}`;
    const keptPrefix = `orgs/${fixture.orgId}/${getCustomSkillStorageName(
      keptWorkflowId,
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
      seedWorkflowStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        workflowId: deletedWorkflowId,
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
        workflowId: keptWorkflowId,
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
        params: { workflowId: deletedWorkflowId },
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

  it("deletes workflows owned by an agent", async () => {
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

    const db = store.set(writeDb$);
    const [seeded] = await db
      .select({ id: zeroWorkflows.id })
      .from(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, fixture.orgId),
          eq(zeroWorkflows.agentId, agent.agentId),
          eq(zeroWorkflows.name, workflowName),
        ),
      );
    if (!seeded) {
      throw new Error("Expected the agent to own the seeded workflow");
    }

    const deleted = await accept(
      detailClient().delete({
        headers: authHeaders(),
        params: { workflowId: seeded.id },
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    const workflows = await db
      .select({ id: zeroWorkflows.id })
      .from(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, fixture.orgId),
          eq(zeroWorkflows.name, workflowName),
        ),
      );
    expect(workflows).toHaveLength(0);
  });
});
