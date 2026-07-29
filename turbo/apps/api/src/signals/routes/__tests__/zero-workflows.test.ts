import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowAutomationsContract,
  zeroWorkflowVisibilityContract,
  type ZeroWorkflowCreateRequest,
  type ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const miscApi = createMiscRoutesApi(context);
const mocks = createZeroRouteMocks(context);
const api = createRunsApi(context);
const connectorApi = createConnectorBddApi(context);
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type StaffFixture =
  | {
      readonly kind: "connector";
      readonly actor: ApiTestUser;
      readonly connectorSlug: ConnectorSlug;
    }
  | {
      readonly kind: "workflow";
      readonly actor: ApiTestUser;
      readonly workflowId: string;
    }
  | {
      readonly kind: "agent";
      readonly actor: ApiTestUser;
      readonly agentId: string;
    };

async function cleanupStaffFixture(fixture: StaffFixture): Promise<void> {
  switch (fixture.kind) {
    case "connector": {
      await connectorApi.deleteConnectorBySlug(
        fixture.actor,
        fixture.connectorSlug,
      );
      return;
    }
    case "workflow": {
      await miscApi.deleteWorkflow(fixture.actor, fixture.workflowId, [204]);
      return;
    }
    case "agent": {
      await bdd.deleteAgent(fixture.actor, fixture.agentId);
      return;
    }
  }
}

const trackStaffFixture =
  createFixtureTracker<StaffFixture>(cleanupStaffFixture);

function registerStaffFixture(fixture: StaffFixture): Promise<StaffFixture> {
  return trackStaffFixture(Promise.resolve(fixture));
}

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

function mockConnectorReadinessModel(
  detected: readonly {
    readonly connectorRef: string;
    readonly reason: string;
  }[],
): void {
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post(OPENROUTER_URL, () => {
      return HttpResponse.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ connectors: detected }),
            },
          },
        ],
      });
    }),
  );
}

function visibilityClient() {
  return setupApp({ context })(zeroWorkflowVisibilityContract);
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

async function createAgent(
  actor: ApiTestUser,
  body: Parameters<typeof bdd.createAgent>[1] = {},
) {
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, body);
  if (actor.orgId === STAFF_ORG_ID) {
    await registerStaffFixture({
      kind: "agent",
      actor,
      agentId: agent.agentId,
    });
  }
  return agent;
}

async function createWorkflow(
  actor: ApiTestUser,
  body: ZeroWorkflowCreateRequest,
) {
  const workflow = await accept(
    collectionClient().create({
      headers: authHeaders(actor),
      body,
    }),
    [201],
  );
  if (actor.orgId === STAFF_ORG_ID) {
    await registerStaffFixture({
      kind: "workflow",
      actor,
      workflowId: workflow.body.id,
    });
  }
  return workflow;
}

async function connectManualGrant(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
  authMethod: Parameters<typeof connectorApi.connectManualGrant>[2],
  values: Parameters<typeof connectorApi.connectManualGrant>[3],
) {
  const connector = await connectorApi.connectManualGrant(
    actor,
    connectorSlug,
    authMethod,
    values,
  );
  if (actor.orgId === STAFF_ORG_ID) {
    await registerStaffFixture({
      kind: "connector",
      actor,
      connectorSlug,
    });
  }
  return connector;
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
  it("lets any public workflow viewer detect connector readiness", async () => {
    const owner = user({ orgId: STAFF_ORG_ID });
    const viewer = user({
      orgId: STAFF_ORG_ID,
      orgRole: "org:member",
    });
    const agent = await createAgent(owner, {
      displayName: "Readiness Agent",
      visibility: "public",
    });
    const workflow = await createWorkflow(owner, {
      agentId: agent.agentId,
      name: `readiness-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      instruction: "Read GitLab projects and Runtime jobs.",
      description: "Coordinate engineering work.",
    });

    await connectManualGrant(viewer, "runtime", "api-token", {
      apiKey: "runtime-readiness-test",
    });
    await connectManualGrant(viewer, "gitlab", "api-token", {
      accessToken: "gitlab-readiness-test",
    });
    await api.enableAgentConnectors(viewer, agent.agentId, ["gitlab"]);

    mockConnectorReadinessModel([
      {
        connectorRef: "gmail",
        reason: "The workflow reads Gmail messages.",
      },
      {
        connectorRef: "runtime",
        reason: "The workflow reads Runtime jobs.",
      },
      {
        connectorRef: "gitlab",
        reason: "The workflow reads GitLab projects.",
      },
    ]);

    const response = await accept(
      detailClient().connectorReadiness({
        headers: authHeaders(viewer),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([
      {
        connectorRef: "gmail",
        label: "Gmail",
        icon: {
          url: "https://static.vm0.io/test-fixtures/connectors/gmail.svg",
          invertInDarkMode: false,
        },
        reason: "The workflow reads Gmail messages.",
        status: "not-connected",
      },
      {
        connectorRef: "runtime",
        label: "Runtime",
        icon: {
          url: "https://static.vm0.io/test-fixtures/connectors/runtime.svg",
          invertInDarkMode: false,
        },
        reason: "The workflow reads Runtime jobs.",
        status: "not-enabled-for-agent",
      },
      {
        connectorRef: "gitlab",
        label: "GitLab",
        icon: {
          url: "https://static.vm0.io/test-fixtures/connectors/gitlab.svg",
          invertInDarkMode: false,
        },
        reason: "The workflow reads GitLab projects.",
        status: "connected",
      },
    ]);
  });

  it("rejects readiness checks when the feature switch is disabled", async () => {
    const actor = user();
    const agent = await createAgent(actor, { visibility: "private" });
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `readiness-disabled-${randomUUID().slice(0, 8)}`,
      instruction: "Read GitHub issues.",
    });

    const response = await accept(
      detailClient().connectorReadiness({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns payload too large before calling the model", async () => {
    const actor = user({ orgId: STAFF_ORG_ID });
    const agent = await createAgent(actor, { visibility: "private" });
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `readiness-large-${randomUUID().slice(0, 8)}`,
      instruction: "x".repeat(100_000),
    });

    const response = await accept(
      detailClient().connectorReadiness({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [413],
    );

    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("fails the whole readiness check when any model ref is unavailable", async () => {
    const actor = user({ orgId: STAFF_ORG_ID });
    const agent = await createAgent(actor, { visibility: "private" });
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `readiness-invalid-${randomUUID().slice(0, 8)}`,
      instruction: "Read an external service.",
    });
    mockConnectorReadinessModel([
      {
        connectorRef: "gmail",
        reason: "The workflow reads Gmail messages.",
      },
      {
        connectorRef: "box",
        reason: "The workflow reads Box files.",
      },
    ]);

    const response = await accept(
      detailClient().connectorReadiness({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector readiness check failed. Please retry.",
      },
    });
  });

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
      canPublish: true,
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

  it("allows workflow names removed from the built-in seed set", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Former Seed Skill Agent",
      visibility: "private",
    });

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: "deep-dive",
      displayName: "Deep Dive",
      instruction: "# custom deep dive workflow",
    });

    expect(created.body).toMatchObject({
      agentId: agent.agentId,
      name: "deep-dive",
      displayName: "Deep Dive",
      ownerUserId: actor.userId,
    });
  });

  it("runs a workflow slash command with workflow timing attribution", async () => {
    const actor = user({ orgRole: "org:admin" });
    await api.grantProEntitlement(actor);
    const provider = await miscApi.upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "workflow-openai-key" },
      [201],
    );
    if (provider.status !== 201) {
      throw new Error("Expected the workflow OpenAI provider to be created");
    }
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: provider.body.provider.id,
      },
    ]);
    const agent = await createAgent(actor, {
      displayName: "Workflow Runner Agent",
      visibility: "private",
    });
    const runnerGroup = api.configureRunnerGroup();

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
    if (!run.body.runId) {
      throw new Error("Expected an idle workflow invocation to create a run");
    }
    expectZeroPreCreateSource(run.body.runId, "workflow_slash_command");

    const queued = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      chatThreadId: run.body.chatThreadId,
      runId: null,
    });

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.body.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.environment?.OPENAI_MODEL).toBe("gpt-5.6-terra");
    expect(claim.environment?.ANTHROPIC_MODEL).toBeUndefined();
    await api.requestCancelRun(actor, run.body.runId, [200]);
  });

  it("requires agent write-permission to create public workflows under an agent", async () => {
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
      canPublish: false,
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
        canPublish: false,
      }),
    );
  });

  it("allows members to create private workflows under visible public agents", async () => {
    const agentOwner = user();
    const member = user({
      orgId: agentOwner.orgId,
      orgRole: "org:member",
    });
    const otherMember = user({
      orgId: agentOwner.orgId,
      orgRole: "org:member",
    });
    const agent = await createAgent(agentOwner, {
      displayName: "Shared Agent",
      visibility: "public",
    });
    const workflowName = `member-private-workflow-${randomUUID().slice(0, 8)}`;

    const created = await createWorkflow(member, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Member Private Workflow",
      instruction: "# member private workflow",
    });

    expect(created.body).toMatchObject({
      agentId: agent.agentId,
      name: workflowName,
      visibility: "private",
      ownerUserId: member.userId,
      canManage: true,
      canPublish: false,
    });

    const updated = await updateWorkflow(member, created.body.id, {
      displayName: "Updated Member Private Workflow",
    });
    expect(updated.body).toMatchObject({
      id: created.body.id,
      displayName: "Updated Member Private Workflow",
      canManage: true,
    });

    await requestUpdateWorkflow(
      agentOwner,
      created.body.id,
      { displayName: "Agent Owner Update" },
      [404],
    );

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(member) }),
      [200],
    );
    expect(memberList.body).toContainEqual(
      expect.objectContaining({
        id: created.body.id,
        name: workflowName,
        canManage: true,
      }),
    );

    const agentOwnerList = await accept(
      collectionClient().list({ headers: authHeaders(agentOwner) }),
      [200],
    );
    expect(names(agentOwnerList.body)).not.toContain(workflowName);

    const otherMemberList = await accept(
      collectionClient().list({ headers: authHeaders(otherMember) }),
      [200],
    );
    expect(names(otherMemberList.body)).not.toContain(workflowName);
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

    context.mocks.ably.publish.mockClear();
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
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${sourceThread.id}`,
      null,
    );
    expect(preparedSource.body.chatThreadId).toBe(sourceThread.id);
    expect(preparedSource.body.prompt).toBe(
      `help me refine the workflow /${sourceWorkflow.body.name}`,
    );

    context.mocks.ably.publish.mockClear();
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
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${sourceThread.id}`,
      null,
    );
  });

  it("creates a workflow when its chat thread notification fails", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Realtime Failure Agent",
      visibility: "private",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Realtime failure chat",
    });

    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("Ably unavailable"),
    );

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      chatThreadId: thread.id,
      name: `realtime-failure-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# realtime failure workflow",
    });

    expect(created.body.agentId).toBe(agent.agentId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${thread.id}`,
      null,
    );
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
    const other = user({ orgId: actor.orgId, orgRole: "org:member" });
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
      visibilityClient().publish({
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

  it("copies workflows and caller-owned automations through the API", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error("Expected workflow copy actor to belong to an org");
    }
    await api.grantProEntitlement(actor, { tier: "team" });
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
    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );
    const webhookAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );
    expect(webhookAutomation.body).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
    });
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

    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    expect(copiedAutomations.body).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        ownerUserId: actor.userId,
        enabled: automation.body.enabled,
      }),
    );
    expect(
      copiedAutomations.body.some((copiedAutomation) => {
        return (
          copiedAutomation.kind === "event" &&
          copiedAutomation.eventType === "webhook-received"
        );
      }),
    ).toBeTruthy();
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
      // The detail endpoint resolves the owner to a display name so the UI does
      // not fall back to rendering the raw Clerk `ownerUserId`.
      ownerUserDisplayName: "BDD User",
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
