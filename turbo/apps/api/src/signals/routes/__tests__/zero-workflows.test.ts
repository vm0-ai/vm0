import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type ZeroWorkflowCreateRequest,
  type ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
createMiscRoutesApi(context);
const mocks = createZeroRouteMocks(context);
const api = createRunsAutomationsApi(context);

function user(options: ApiTestUserOptions = {}): ApiTestUser {
  return bdd.user(options);
}

function authHeaders(actor: ApiTestUser): { readonly authorization: string } {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function collectionClient() {
  return setupApp({ context })(zeroWorkflowsCollectionContract);
}

function detailClient() {
  return setupApp({ context })(zeroWorkflowsDetailContract);
}

function visibilityClient() {
  return setupApp({ context })(zeroWorkflowVisibilityContract);
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function createAgent(
  actor: ApiTestUser,
  body: Parameters<typeof bdd.createAgent>[1] = {},
) {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, body);
}

async function createWorkflow(
  actor: ApiTestUser,
  body: ZeroWorkflowCreateRequest,
) {
  return await accept(
    collectionClient().create({
      headers: authHeaders(actor),
      body,
    }),
    [201],
  );
}

async function requestCreateWorkflow<
  TStatus extends 400 | 401 | 403 | 404 | 409,
>(
  actor: ApiTestUser,
  body: ZeroWorkflowCreateRequest,
  statuses: readonly TStatus[],
) {
  return await accept(
    collectionClient().create({
      headers: authHeaders(actor),
      body,
    }),
    statuses,
  );
}

async function updateWorkflow(
  actor: ApiTestUser,
  workflowId: string,
  body: ZeroWorkflowUpdateRequest,
) {
  return await accept(
    detailClient().update({
      headers: authHeaders(actor),
      params: { workflowId },
      body,
    }),
    [200],
  );
}

async function requestUpdateWorkflow<
  TStatus extends 400 | 401 | 403 | 404 | 409,
>(
  actor: ApiTestUser,
  workflowId: string,
  body: ZeroWorkflowUpdateRequest,
  statuses: readonly TStatus[],
) {
  return await accept(
    detailClient().update({
      headers: authHeaders(actor),
      params: { workflowId },
      body,
    }),
    statuses,
  );
}

function names(workflows: readonly { readonly name: string }[]): string[] {
  return workflows.map((workflow) => {
    return workflow.name;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.run_id === runId;
    });
  });
}

function expectZeroPreCreateSource(runId: string, source: string): void {
  expect(sandboxOperationEventsForRun(runId)).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op_type: "api_dispatch_pre_create_agent_run",
        zero_pre_create_source: source,
      }),
    ]),
  );
}

describe("zero workflows", () => {
  it("creates private workflows by default and hides them from other org members", async () => {
    const owner = user();
    const otherMember = user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner, {
      displayName: "Owner Agent",
      visibility: "private",
    });

    const created = await createWorkflow(owner, {
      agentId: agent.agentId,
      name: `owner-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Owner Workflow",
      instruction: "# owner workflow",
    });

    expect(created.body).toMatchObject({
      displayName: "Owner Workflow",
      visibility: "private",
      ownerUserId: owner.userId,
      agentId: agent.agentId,
      canManage: true,
    });

    const ownerList = await accept(
      collectionClient().list({ headers: authHeaders(owner) }),
      [200],
    );
    expect(names(ownerList.body)).toContain(created.body.name);

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(otherMember) }),
      [200],
    );
    expect(names(memberList.body)).not.toContain(created.body.name);
  });

  it("runs a workflow slash command with workflow timing attribution", async () => {
    const actor = user({ orgRole: "org:admin" });
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await createAgent(actor, {
      displayName: "Workflow Runner Agent",
      visibility: "private",
    });
    api.configureRunnerGroup();

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `run-attribution-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Run Attribution Workflow",
      instruction: "# run attribution workflow",
    });

    const run = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );

    expect(run.body.chatThreadId).toStrictEqual(expect.any(String));
    expect(run.body.runId).toStrictEqual(expect.any(String));
    expectZeroPreCreateSource(run.body.runId, "workflow_slash_command");
  });

  it("requires agent write-permission to create workflows under an agent", async () => {
    const owner = user();
    const member = user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner, {
      displayName: "Public Agent",
      visibility: "public",
    });
    const workflowName = `public-workflow-${randomUUID().slice(0, 8)}`;

    const rejected = await requestCreateWorkflow(
      member,
      {
        agentId: agent.agentId,
        name: workflowName,
        visibility: "public",
        instruction: "# public workflow",
      },
      [403],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can create workflows on this agent",
        code: "FORBIDDEN",
      },
    });

    const created = await createWorkflow(owner, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });
    expect(created.body).toMatchObject({
      name: workflowName,
      visibility: "public",
      canManage: true,
    });

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(member) }),
      [200],
    );
    expect(memberList.body).toContainEqual(
      expect.objectContaining({
        name: workflowName,
        visibility: "public",
        canManage: false,
      }),
    );
  });

  it("binds a newly created workflow only to a current matching agent chat thread", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Target Agent",
      visibility: "private",
    });
    const sourceThread = await chat.createThread(actor, {
      agentId: sourceAgent.agentId,
      title: "Source chat",
    });

    const sourceWorkflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      chatThreadId: sourceThread.id,
      name: `source-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# source workflow",
    });
    const preparedSource = await accept(
      detailClient().chatThread({
        headers: authHeaders(actor),
        params: { workflowId: sourceWorkflow.body.id },
      }),
      [200],
    );
    expect(preparedSource.body.chatThreadId).toBe(sourceThread.id);

    const targetWorkflow = await createWorkflow(actor, {
      agentId: targetAgent.agentId,
      chatThreadId: sourceThread.id,
      name: `target-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# target workflow",
    });
    const preparedTarget = await accept(
      detailClient().chatThread({
        headers: authHeaders(actor),
        params: { workflowId: targetWorkflow.body.id },
      }),
      [200],
    );
    expect(preparedTarget.body.chatThreadId).not.toBe(sourceThread.id);
  });

  it("protects public workflow slugs while allowing private overrides", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Unique Slug Agent",
      visibility: "public",
    });
    const otherAgent = await createAgent(actor, {
      displayName: "Other Unique Slug Agent",
      visibility: "public",
    });
    const workflowName = `shared-workflow-${randomUUID().slice(0, 8)}`;

    const publicWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Public Workflow",
      visibility: "public",
      instruction: "# shared workflow",
    });
    const privateWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Private Workflow",
      instruction: "# private override",
    });
    await createWorkflow(actor, {
      agentId: otherAgent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# other agent workflow",
    });

    const duplicate = await requestCreateWorkflow(
      actor,
      {
        agentId: agent.agentId,
        name: workflowName,
        visibility: "public",
        instruction: "# duplicate public workflow",
      },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `/${workflowName}" already exists on this agent`,
    );

    const scopedList = await accept(
      collectionClient().list({
        headers: authHeaders(actor),
        query: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(scopedList.body).toContainEqual(
      expect.objectContaining({
        id: publicWorkflow.body.id,
        shadowedBy: {
          id: privateWorkflow.body.id,
          name: workflowName,
          displayName: "Private Workflow",
        },
      }),
    );
    expect(scopedList.body).toContainEqual(
      expect.objectContaining({
        id: privateWorkflow.body.id,
        shadowedBy: null,
      }),
    );
  });

  it("rejects same-owner private workflow slugs while allowing other-owner private slugs", async () => {
    const actor = user();
    const other = user({ orgId: actor.orgId });
    const agent = await createAgent(actor, {
      displayName: "Private Slug Agent",
      visibility: "public",
    });
    const workflowName = `private-workflow-${randomUUID().slice(0, 8)}`;

    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# private workflow",
    });

    const duplicate = await requestCreateWorkflow(
      actor,
      {
        agentId: agent.agentId,
        name: workflowName,
        instruction: "# duplicate private workflow",
      },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );

    const otherPrivate = await createWorkflow(other, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# other user private workflow",
    });
    expect(otherPrivate.body).toMatchObject({
      agentId: agent.agentId,
      name: workflowName,
      ownerUserId: other.userId,
      visibility: "private",
    });
  });

  it("renames workflow slugs through metadata update and rejects duplicate public slugs", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Rename Agent",
      visibility: "public",
    });
    const existingName = `existing-workflow-${randomUUID().slice(0, 8)}`;
    const renamedName = `renamed-workflow-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: existingName,
      visibility: "public",
      instruction: "# existing workflow",
    });
    const source = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `rename-source-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      displayName: "Rename Source",
      description: "Original description",
      instruction: "# rename source",
    });

    const renamed = await updateWorkflow(actor, source.body.id, {
      name: renamedName,
      displayName: "Renamed Workflow",
      description: "Use when workflow metadata needs a new slug.",
    });
    expect(renamed.body).toMatchObject({
      name: renamedName,
      displayName: "Renamed Workflow",
      description: "Use when workflow metadata needs a new slug.",
    });

    const duplicate = await requestUpdateWorkflow(
      actor,
      source.body.id,
      { name: existingName },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `/${existingName}" already exists on this agent`,
    );
  });

  it("rejects renaming a private workflow to another same-owner private slug", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Private Rename Agent",
      visibility: "public",
    });
    const existingName = `private-existing-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: existingName,
      instruction: "# existing private workflow",
    });
    const source = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `private-rename-source-${randomUUID().slice(0, 8)}`,
      instruction: "# source private workflow",
    });

    const duplicate = await requestUpdateWorkflow(
      actor,
      source.body.id,
      { name: existingName },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${existingName}"`,
    );
  });

  it("rejects publishing a private workflow when the public slug is already taken", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Publish Conflict Agent",
      visibility: "public",
    });
    const workflowName = `publish-conflict-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });
    const privateWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# private workflow",
    });

    const response = await accept(
      visibilityClient().requestPublish({
        headers: authHeaders(actor),
        params: { workflowId: privateWorkflow.body.id },
      }),
      [409],
    );
    expect(response.body.error.message).toContain(
      `/${workflowName}" already exists on this agent`,
    );
  });

  it("rejects copying a workflow when the caller already has that private slug on the target agent", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Private Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Private Copy Target Agent",
      visibility: "private",
    });
    const workflowName = `copy-conflict-${randomUUID().slice(0, 8)}`;
    const source = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: workflowName,
      instruction: "# source workflow",
    });
    await createWorkflow(actor, {
      agentId: targetAgent.agentId,
      name: workflowName,
      instruction: "# existing private workflow",
    });

    const duplicate = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: source.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );
  });

  it("rejects demoting a public workflow when the owner already has that private slug", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Private Demote Agent",
      visibility: "public",
    });
    const workflowName = `demote-conflict-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# existing private workflow",
    });
    const publicWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });

    const duplicate = await accept(
      visibilityClient().demote({
        headers: authHeaders(actor),
        params: { workflowId: publicWorkflow.body.id },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );
  });

  it("copies workflows and caller-owned triggers through the API", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `copy-source-${randomUUID().slice(0, 8)}`,
      instruction: "# copy source",
    });
    const trigger = await accept(
      triggersClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(copied.body).toMatchObject({
      agentId: targetAgent.agentId,
      name: workflow.body.name,
      ownerUserId: actor.userId,
    });
    expect(copied.body.id).not.toBe(workflow.body.id);

    const copiedTriggers = await accept(
      triggersClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    expect(copiedTriggers.body).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        ownerUserId: actor.userId,
        enabled: trigger.body.enabled,
      }),
    );
  });

  it("reads and updates workflow content, audit metadata, and deletion through API responses", async () => {
    const creator = user();
    const updater = user({ orgId: creator.orgId, orgRole: "org:admin" });
    const agent = await createAgent(creator, {
      displayName: "Audit Agent",
      visibility: "public",
    });
    const workflow = await createWorkflow(creator, {
      agentId: agent.agentId,
      name: `audit-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Audit Workflow",
      instruction: "# audit workflow",
      files: [{ path: "notes.md", content: "initial notes" }],
      visibility: "public",
    });

    const initial = await accept(
      detailClient().get({
        headers: authHeaders(creator),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(initial.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: creator.userId,
      instruction: "# audit workflow",
    });
    expect(typeof initial.body.createdAt).toBe("string");
    expect(typeof initial.body.updatedAt).toBe("string");

    const updated = await updateWorkflow(updater, workflow.body.id, {
      displayName: "Updated Audit Workflow",
      instruction: "# updated workflow",
      files: [{ path: "notes.md", content: "updated notes" }],
    });
    expect(updated.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: updater.userId,
      displayName: "Updated Audit Workflow",
      instruction: "# updated workflow",
    });

    await accept(
      detailClient().delete({
        headers: authHeaders(updater),
        params: { workflowId: workflow.body.id },
      }),
      [204],
    );
    const missing = await accept(
      detailClient().get({
        headers: authHeaders(creator),
        params: { workflowId: workflow.body.id },
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});
