import { createHash, randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { testBrowserReconcileContract } from "@okouai/api-contracts/contracts/test-browser-reconcile";
import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  officialWorkflowInstallationsContract,
  officialWorkflowsContract,
} from "@okouai/api-contracts/contracts/official-workflows";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateContract } from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture,
  corruptOfficialWorkflowRevisionPayloadFixture,
  installOfficialWorkflowRunGateFixture,
  readAgentRunFamilyCountsFixture,
  readChatEventRowsAsPreviousApiFixture,
  readLatestWorkflowAutomationRunFixture,
  readOfficialWorkflowRunStateFixture,
  readWorkflowAutomationAutonomyFixture,
  retargetWorkflowAutomationFixture,
  seedVm0BuiltInModelKey,
  setOfficialWorkflowAutomationAdmissionStateFixture,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { createCronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { officialWorkflowRoutes } from "../official-workflows";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowsRoutes } from "../workflows";
import { testBrowserReconcileRoutes } from "../test-browser-reconcile";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const bdd = createBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const outbox = createEmailOutboxStateApi(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";
const GMAIL_TOPIC_NAME =
  "projects/vm0-ai-488909/topics/official-workflow-gmail-events";
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function selectBuiltInDefaultModel(actor: ApiTestUser): Promise<void> {
  await seedVm0BuiltInModelKey(context, "claude-sonnet-5");
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions,
  };
}

function scheduledBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "daily",
    parameters: [
      {
        key: "time-zone",
        type: "string",
        format: "timezone",
        required: true,
        derivation: { kind: "user-timezone" },
      },
      {
        key: "cron-expression",
        type: "string",
        format: "text",
        required: false,
        default: "0 8 * * *",
      },
      {
        key: "include-weekends",
        type: "boolean",
        required: false,
        default: false,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "cron",
        cronExpression: { parameter: "cron-expression" },
        timezone: { parameter: "time-zone" },
      },
      autonomyBudget: 4,
    },
    runtime: { resultEmail },
  };
}

function loopBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "pulse",
    parameters: [
      {
        key: "interval-seconds",
        type: "integer",
        required: true,
      },
      {
        key: "autonomy-budget",
        type: "integer",
        required: false,
        default: 3,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "loop",
        intervalSeconds: { parameter: "interval-seconds" },
      },
      autonomyBudget: { parameter: "autonomy-budget" },
    },
    runtime: { resultEmail },
  };
}

function onceBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "one-shot",
    parameters: [
      {
        key: "at-time",
        type: "string",
        format: "date-time",
        required: true,
      },
      {
        key: "time-zone",
        type: "string",
        format: "timezone",
        required: true,
        derivation: { kind: "user-timezone" },
      },
      {
        key: "callback-url",
        type: "string",
        format: "url",
        required: true,
      },
      {
        key: "correlation-id",
        type: "string",
        format: "uuid",
        required: true,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "once",
        atTime: { parameter: "at-time" },
        timezone: { parameter: "time-zone" },
      },
    },
    runtime: { resultEmail },
  };
}

function gmailBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "gmail-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: { provider: "gmail", event: "new_message" },
    },
    runtime: { resultEmail: false },
  };
}

function gmailLabelBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "gmail-label-trigger",
    parameters: [
      {
        key: "label-name",
        type: "string",
        format: "text",
        required: true,
      },
    ],
    desiredState: {
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: { parameter: "label-name" },
      },
    },
    runtime: { resultEmail: false },
  };
}

function webhookBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "webhook-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "webhook-received",
    },
    runtime: { resultEmail },
  };
}

function activeDefinition(
  name: string,
  blueprints: readonly OfficialWorkflowBlueprint[],
  instruction = "Execute only the accepted Definition content.",
): ActiveDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: `Display ${name}`,
      description: `Description for ${name}`,
      instruction,
      files: [{ path: "references/context.md", content: "accepted\n" }],
    },
    blueprints: [...blueprints],
    presentation: {
      category: "productivity",
      order: 1,
      marketingCopy: "Official catalog entry.",
    },
  };
}

function retiredDefinition(
  name: string,
): Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "retired" }
> {
  return {
    name,
    lifecycle: "retired",
    presentation: {
      category: "retired",
      order: 99,
      marketingCopy: "Retired Official Workflow.",
    },
  };
}

function syncClient(candidate: unknown) {
  return setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
  })(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await accept(
    syncClient(candidate).sync({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

function stateClient() {
  return setupApp({
    context,
    routes: testOfficialWorkflowCatalogStateRoutes,
  })(testOfficialWorkflowCatalogStateContract);
}

async function cleanupCatalog() {
  await accept(stateClient().action({ body: { action: "cleanup" } }), [200]);
}

function officialClient() {
  return setupApp({ context, routes: officialWorkflowRoutes })(
    officialWorkflowsContract,
  );
}

function installationClient() {
  return setupApp({ context, routes: officialWorkflowRoutes })(
    officialWorkflowInstallationsContract,
  );
}

function workflowClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function workflowCollectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function workflowVisibilityClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function automationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
}

function storageClient() {
  return setupApp({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

function staleQueueReconcileClient() {
  return setupApp({ context, routes: testBrowserReconcileRoutes })(
    testBrowserReconcileContract,
  );
}

async function reconcileStaleQueuedMessages(threadId: string): Promise<void> {
  await accept(
    staleQueueReconcileClient().reconcile({
      body: { chat_thread_ids: [threadId] },
    }),
    [200],
  );
}

async function readAcceptedDefinitionFixture(definitionName: string) {
  const response = await accept(
    stateClient().action({ body: { action: "read", definitionName } }),
    [200],
  );
  if (!response.body.definition || !response.body.storage) {
    throw new Error(`Accepted Definition is unavailable: ${definitionName}`);
  }
  return {
    definition: response.body.definition,
    storage: response.body.storage,
  };
}

async function postOfficialWorkflowWebhook(args: {
  readonly webhookUrl: string;
  readonly secret: string;
  readonly body: string;
}) {
  const url = new URL(args.webhookUrl);
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: [
      ...webhooksWorkflowAutomationsRoutes,
      ...workflowAutomationsRoutes,
    ],
  }).request(url.pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-VM0-Timestamp": String(timestamp),
      "X-VM0-Signature": computeHmacSignature(
        args.body,
        args.secret,
        timestamp,
      ),
    },
    body: args.body,
  });
  return { status: response.status, body: await response.json() };
}

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function installCatalogStorageFixture(): void {
  const objects = new Map<string, Buffer>();
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      objects.set(key, s3BodyBuffer(command.input.Body));
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      return body
        ? Promise.resolve({ ContentLength: body.length })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([Key, body]) => {
          return Key.startsWith(prefix)
            ? [{ Key, Size: body.length, LastModified: new Date(0) }]
            : [];
        }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
      return Promise.resolve({});
    }
    if (!fallback) {
      return Promise.reject(
        new Error(
          `Unexpected S3 command in Official Workflow storage fixture: ${command?.constructor.name ?? "unknown"}`,
        ),
      );
    }
    return fallback(command);
  });
}

async function setOfficialWorkflowsEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.OfficialWorkflows]: enabled },
  );
}

function configureResultEmailRecipient(actor: ApiTestUser): void {
  const emailId = `email_${actor.userId}`;
  mockEnv("APP_URL", "https://app.vm0.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
  mockEnv("VM0_API_BACKEND_URL", undefined);
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "Official",
        lastName: "Automation",
        imageUrl: null,
      },
    ],
  });
}

async function completeSuccessfulRun(
  runnerGroup: string,
  runId: string,
  output: string,
): Promise<void> {
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(runId);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooks.requestAgentEvents(
    {
      runId,
      events: [{ type: "result", sequenceNumber: 0, result: output }],
    },
    headers,
    [200],
  );
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `official-result-email-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`official result email history ${runId}`)
        .digest("hex"),
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0, lastEventSequence: 0 },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
}

async function installResultEmailLoopScenario(
  prefix: string,
  resultEmail: boolean,
) {
  installCatalogStorageFixture();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const definitionName = `${prefix}-${suffix}`;
  await syncCatalog(
    catalog([activeDefinition(definitionName, [loopBlueprint(resultEmail)])]),
  );
  const { actor } = await workflowBdd.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const { agentId } = await workflowBdd.createAgent(actor);
  const headers = authHeaders(actor);
  await setOfficialWorkflowsEnabled(actor, true);
  const installed = await accept(
    officialClient().install({
      headers,
      params: { definitionName },
      body: {
        agentId,
        blueprints: [
          {
            blueprintKey: "pulse",
            bindings: [{ key: "interval-seconds", value: 60 }],
          },
        ],
      },
    }),
    [201],
  );
  const automation = installed.body.workflow.automations.find((candidate) => {
    return candidate.official?.blueprintKey === "pulse";
  });
  if (!automation) {
    throw new Error("Expected Official result email loop Automation");
  }
  configureResultEmailRecipient(actor);
  const runnerGroup = runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await bdd.deleteAgent(actor, agentId);
    await cleanupCatalog();
  });
  return {
    actor,
    agentId,
    automation,
    definitionName,
    headers,
    installed,
    runnerGroup,
  };
}

beforeEach(async () => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `official-workflow-installation-test-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog();
  await cleanupCatalog();
});

describe.sequential("Official Workflow installations", () => {
  it("installs, guards, reconfigures, retires, and uninstalls through public boundaries", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-install-${suffix}`;
    const zeroBlueprintName = `api-test-zero-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          scheduledBlueprint(true),
          onceBlueprint(),
          loopBlueprint(),
        ]),
        activeDefinition(zeroBlueprintName, []),
      ]),
    );

    const staffActor = bdd.user({ orgId: STAFF_ORG_ID });
    const staffHeaders = authHeaders(staffActor);
    await accept(officialClient().list({ headers: staffHeaders }), [200]);
    await setOfficialWorkflowsEnabled(staffActor, false);
    await accept(officialClient().list({ headers: staffHeaders }), [403]);

    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const actor = setup.actor;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    const headers = authHeaders(actor);
    await accept(officialClient().list({ headers }), [403]);
    await setOfficialWorkflowsEnabled(actor, true);
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      { [FeatureSwitchKey.WorkflowConnectorReadiness]: true },
    );

    const sharedAgentOwner = bdd.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const { agentId: publicAgentId } = await workflowBdd.createAgent(
      sharedAgentOwner,
      { visibility: "public" },
    );
    const { agentId: privateAgentId } = await workflowBdd.createAgent(
      sharedAgentOwner,
      { visibility: "private" },
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(sharedAgentOwner, publicAgentId);
      await bdd.deleteAgent(sharedAgentOwner, privateAgentId);
    });
    authHeaders(actor);
    const publicAgentInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId: publicAgentId, blueprints: [] },
      }),
      [201],
    );
    expect(publicAgentInstallation.body.workflow).toMatchObject({
      agentId: publicAgentId,
      ownerUserId: actor.userId,
      visibility: "private",
    });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: publicAgentInstallation.body.workflow.id },
      }),
      [204],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId: privateAgentId, blueprints: [] },
      }),
      [403],
    );

    const discovered = await accept(officialClient().list({ headers }), [200]);
    expect(
      discovered.body.map((entry) => {
        return entry.name;
      }),
    ).toStrictEqual([definitionName, zeroBlueprintName]);
    const catalogDetail = await accept(
      officialClient().get({
        headers,
        params: { definitionName },
      }),
      [200],
    );
    expect(catalogDetail.body.workflow).toMatchObject({
      instruction: "Execute only the accepted Definition content.",
      files: [{ path: "references/context.md", content: "accepted\n" }],
    });

    const installBody = {
      agentId,
      blueprints: [
        {
          blueprintKey: "daily",
          bindings: [
            { key: "cron-expression", value: "0 7 * * *" },
            { key: "include-weekends", value: true },
          ],
        },
        {
          blueprintKey: "one-shot",
          bindings: [
            { key: "at-time", value: "2099-01-01T00:00:00Z" },
            { key: "callback-url", value: "https://example.com/callback" },
            {
              key: "correlation-id",
              value: "00000000-0000-4000-8000-000000000001",
            },
          ],
        },
        {
          blueprintKey: "pulse",
          bindings: [{ key: "interval-seconds", value: 3600 }],
        },
      ],
    };
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.slice(0, 2),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            ...installBody.blueprints,
            { blueprintKey: "unknown-blueprint", bindings: [] },
          ],
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: entry.bindings.filter((binding) => {
                    return binding.key !== "callback-url";
                  }),
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "pulse"
              ? {
                  ...entry,
                  bindings: [
                    { key: "interval-seconds", value: "not-an-integer" },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: [
                    ...entry.bindings,
                    { key: "unknown-parameter", value: true },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: entry.bindings.map((binding) => {
                    return binding.key === "callback-url"
                      ? { ...binding, value: "not-a-url" }
                      : binding;
                  }),
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "daily"
              ? {
                  ...entry,
                  bindings: [
                    ...entry.bindings,
                    { key: "cron-expression", value: "0 11 * * *" },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    const concurrent = await Promise.all([
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
    ]);
    expect(
      concurrent
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const installed = concurrent.find((response) => {
      return response.status === 201;
    });
    if (!installed || installed.status !== 201) {
      throw new Error("Expected one successful concurrent installation");
    }
    const firstWorkflowId = installed.body.workflow.id;
    const dailyAutomation = installed.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "daily";
      },
    );
    const automationIds = installed.body.workflow.automations.map(
      (automation) => {
        return automation.id;
      },
    );
    const automationThreadById = new Map(
      installed.body.workflow.automations.map((automation) => {
        return [automation.id, automation.chatThreadId] as const;
      }),
    );
    expect(installed.body.workflow.automations).toHaveLength(3);
    expect(
      installed.body.workflow.automations.every((automation) => {
        return automation.enabled;
      }),
    ).toBeTruthy();
    expect(installed.body.workflow).toMatchObject({
      name: definitionName,
      visibility: "private",
      instruction: "Execute only the accepted Definition content.",
      fileContents: [{ path: "references/context.md", content: "accepted\n" }],
      canManage: false,
      canPublish: false,
      official: {
        definitionName,
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    });
    const workspaceEntries = await accept(
      automationClient().listWorkspace({ headers }),
      [200],
    );
    expect(
      workspaceEntries.body.find((entry) => {
        return entry.workflow.id === firstWorkflowId;
      }),
    ).toMatchObject({
      workflow: {
        official: {
          definitionName,
          installationState: "installed",
          definitionLifecycle: "active",
          readOnly: true,
        },
      },
      automation: { official: { reconciliationStatus: "current" } },
    });
    if (!dailyAutomation) {
      throw new Error("Expected Official Workflow automation");
    }
    expect(dailyAutomation).toMatchObject({
      kind: "schedule",
      enabled: true,
      schedule: {
        type: "cron",
        cronExpression: "0 7 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        blueprintKey: "daily",
        reconciliationStatus: "current",
        intendedEnabled: true,
        parameterBindings: expect.arrayContaining([
          { key: "time-zone", value: "Asia/Shanghai" },
          { key: "cron-expression", value: "0 7 * * *" },
          { key: "include-weekends", value: true },
        ]),
      },
    });
    expect(dailyAutomation.official?.parameterBindings).toHaveLength(3);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: true,
      officialBlueprintKey: "daily",
      officialResultEmailEnabled: true,
    });
    for (const automation of installed.body.workflow.automations) {
      if (automation.id === dailyAutomation.id) {
        continue;
      }
      await expect(
        readWorkflowAutomationAutonomyFixture(context, automation.id),
      ).resolves.toMatchObject({
        officialBlueprintKey: automation.official?.blueprintKey,
        officialResultEmailEnabled: false,
      });
    }

    const customStorage = await accept(
      storageClient().action({
        body: {
          action: "read-storage-state",
          org_id: actor.orgId,
          user_id: VOLUME_ORG_USER_ID,
          storage_name: getCustomSkillStorageName(firstWorkflowId),
        },
      }),
      [200],
    );
    expect(customStorage.body.storage_state).toBeNull();

    const duplicate = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [409],
    );
    expect(duplicate.body.error.message).toBe(
      "Official Workflow is already installed on this agent",
    );

    const { agentId: secondAgentId } = await workflowBdd.createAgent(actor);
    let secondAgentDeleted = false;
    onTestFinished(async () => {
      if (!secondAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, secondAgentId);
      }
    });
    const secondInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { ...installBody, agentId: secondAgentId },
      }),
      [201],
    );
    expect(secondInstallation.body.workflow.id).not.toBe(firstWorkflowId);
    await bdd.deleteAgent(actor, secondAgentId);
    secondAgentDeleted = true;
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: secondInstallation.body.workflow.id },
      }),
      [404],
    );

    const { agentId: ordinaryAgentId } = await workflowBdd.createAgent(actor);
    let ordinaryAgentDeleted = false;
    onTestFinished(async () => {
      if (!ordinaryAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, ordinaryAgentId);
      }
    });
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId: ordinaryAgentId,
      name: definitionName,
      visibility: "private",
    });
    const ordinaryConflict = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { ...installBody, agentId: ordinaryAgentId },
      }),
      [409],
    );
    expect(ordinaryConflict.body.error.message).toBe(
      `A private workflow named "${definitionName}" already exists on this agent`,
    );
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: ordinaryWorkflowId },
      }),
      [204],
    );
    await bdd.deleteAgent(actor, ordinaryAgentId);
    ordinaryAgentDeleted = true;

    await accept(
      workflowClient().update({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { displayName: "Forged edit" },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().publish({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().demote({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: agentId },
      }),
      [409],
    );
    await accept(
      workflowClient().chatThread({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().connectorReadiness({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      automationClient().create({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().update({
        headers,
        params: { id: dailyAutomation.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().delete({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [409],
    );
    const pulseAutomation = installed.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "pulse";
      },
    );
    if (!pulseAutomation) {
      throw new Error("Expected Official Workflow loop automation");
    }
    const paused = await accept(
      automationClient().disable({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({
      enabled: false,
      nextRunAt: null,
      official: { intendedEnabled: false },
    });
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: false,
      officialResultEmailEnabled: true,
    });

    const reconfigured = await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [{ key: "cron-expression", value: "0 9 * * *" }],
            },
          ],
        },
      }),
      [200],
    );
    const reconfiguredDaily = reconfigured.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "daily";
      },
    );
    expect(reconfiguredDaily).toMatchObject({
      id: dailyAutomation.id,
      enabled: false,
      schedule: {
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        intendedEnabled: false,
        reconciliationStatus: "current",
      },
    });
    expect(
      reconfigured.body.workflow.automations
        .map((automation) => {
          return automation.id;
        })
        .sort(),
    ).toStrictEqual([...automationIds].sort());
    expect(
      reconfigured.body.workflow.automations.every((automation) => {
        return (
          automation.chatThreadId === automationThreadById.get(automation.id)
        );
      }),
    ).toBeTruthy();
    expect(
      reconfigured.body.workflow.automations.every((automation) => {
        return automation.id === dailyAutomation.id || automation.enabled;
      }),
    ).toBeTruthy();
    await accept(
      automationClient().enable({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: true,
      officialResultEmailEnabled: true,
    });

    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [204],
    );
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [404],
    );
    const reinstalled = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [201],
    );
    expect(reinstalled.body.workflow.id).not.toBe(firstWorkflowId);
    const reinstalledDailyAutomation =
      reinstalled.body.workflow.automations.find((automation) => {
        return automation.official?.blueprintKey === "daily";
      });
    if (!reinstalledDailyAutomation) {
      throw new Error("Expected reinstalled daily automation");
    }

    const zeroInstalled = await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    expect(zeroInstalled.body.workflow.automations).toStrictEqual([]);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: zeroInstalled.body.workflow.id },
      }),
      [204],
    );

    await syncCatalog(
      catalog([
        retiredDefinition(definitionName),
        activeDefinition(zeroBlueprintName, []),
      ]),
    );
    const retiredInstallation = await accept(
      installationClient().get({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
      }),
      [200],
    );
    expect(
      retiredInstallation.body.workflow.official?.definitionLifecycle,
    ).toBe("retired");
    await accept(
      officialClient().get({
        headers,
        params: { definitionName },
      }),
      [404],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [409],
    );

    await setOfficialWorkflowsEnabled(actor, false);
    await accept(officialClient().list({ headers }), [403]);
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
      }),
      [200],
    );
    await accept(
      automationClient().disable({
        headers,
        params: { id: reinstalledDailyAutomation.id },
      }),
      [200],
    );
    await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [{ key: "cron-expression", value: "0 10 * * *" }],
            },
          ],
        },
      }),
      [200],
    );
    await accept(
      automationClient().enable({
        headers,
        params: { id: reinstalledDailyAutomation.id },
      }),
      [200],
    );
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
      }),
      [204],
    );
  });

  it("rejects observed-release races during installation and reconfiguration", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-race-${suffix}`;
    const blueprint = gmailLabelBlueprint();
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [blueprint],
          "Accepted Definition revision one.",
        ),
      ]),
    );

    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const actor = setup.actor;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    mockGmailConnectorOAuth({ email: `official-race-${suffix}@example.test` });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);

    const watchStarted = createDeferredPromise<void>(context.signal);
    const releaseWatch = createDeferredPromise<void>(context.signal);
    const labelLookupStarted = createDeferredPromise<void>(context.signal);
    const releaseLabelLookup = createDeferredPromise<void>(context.signal);
    let blockNextWatch = true;
    let blockNextLabelLookup = false;
    let stopCalls = 0;
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        async () => {
          if (blockNextLabelLookup) {
            blockNextLabelLookup = false;
            labelLookupStarted.resolve(undefined);
            await releaseLabelLookup.promise;
          }
          return HttpResponse.json({
            labels: [
              { id: "Label_important", name: "Important" },
              { id: "Label_follow_up", name: "Follow Up" },
            ],
          });
        },
      ),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        async () => {
          if (blockNextWatch) {
            blockNextWatch = false;
            watchStarted.resolve(undefined);
            await releaseWatch.promise;
          }
          return HttpResponse.json({
            historyId: "100",
            expiration: "4102444800000",
          });
        },
      ),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        stopCalls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installBody = {
      agentId,
      blueprints: [
        {
          blueprintKey: "gmail-label-trigger",
          bindings: [{ key: "label-name", value: "Important" }],
        },
      ],
    };

    const installing = accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [409],
    );
    await watchStarted.promise;
    const installingWorkspaceAutomations = await accept(
      automationClient().listWorkspace({ headers }),
      [200],
    );
    expect(
      installingWorkspaceAutomations.body.some((entry) => {
        return entry.workflow.name === definitionName;
      }),
    ).toBeFalsy();
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [blueprint],
          "Accepted Definition revision two.",
        ),
      ]),
    );
    releaseWatch.resolve(undefined);
    const installConflict = await installing;
    expect(installConflict.body.error.message).toBe(
      "Official Workflow changed during installation; retry",
    );
    const afterInstallConflict = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId },
      }),
      [200],
    );
    expect(
      afterInstallConflict.body.some((workflow) => {
        return workflow.name === definitionName;
      }),
    ).toBeFalsy();
    expect(stopCalls).toBeGreaterThan(0);

    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [201],
    );
    const installedAutomation = installed.body.workflow.automations[0];
    if (!installedAutomation) {
      throw new Error("Expected Official Gmail automation");
    }

    blockNextLabelLookup = true;
    const reconfiguring = accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "gmail-label-trigger",
              bindings: [{ key: "label-name", value: "Follow Up" }],
            },
          ],
        },
      }),
      [409],
    );
    await labelLookupStarted.promise;
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [blueprint],
          "Accepted Definition revision three.",
        ),
      ]),
    );
    releaseLabelLookup.resolve(undefined);
    const reconfigureConflict = await reconfiguring;
    expect(reconfigureConflict.body.error.message).toBe(
      "Official Workflow changed during reconfiguration; retry",
    );
    const unchanged = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unchanged.body.workflow.instruction).toBe(
      "Accepted Definition revision three.",
    );
    expect(unchanged.body.workflow.automations[0]?.official).toMatchObject({
      reconciliationStatus: "current",
      parameterBindings: [{ key: "label-name", value: "Important" }],
    });

    const reconfigured = await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "gmail-label-trigger",
              bindings: [{ key: "label-name", value: "Follow Up" }],
            },
          ],
        },
      }),
      [200],
    );
    expect(reconfigured.body.workflow.automations[0]).toMatchObject({
      id: installedAutomation.id,
      chatThreadId: installedAutomation.chatThreadId,
      official: {
        reconciliationStatus: "current",
        parameterBindings: [{ key: "label-name", value: "Follow Up" }],
      },
    });

    const concurrentLookupStarted = createDeferredPromise<void>(context.signal);
    const releaseConcurrentLookup = createDeferredPromise<void>(context.signal);
    let blockConcurrentLookup = true;
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        async () => {
          if (blockConcurrentLookup) {
            blockConcurrentLookup = false;
            concurrentLookupStarted.resolve(undefined);
            await releaseConcurrentLookup.promise;
          }
          return HttpResponse.json({
            labels: [
              { id: "Label_important", name: "Important" },
              { id: "Label_follow_up", name: "Follow Up" },
            ],
          });
        },
      ),
    );
    const concurrentReconfiguration = accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "gmail-label-trigger",
              bindings: [{ key: "label-name", value: "Important" }],
            },
          ],
        },
      }),
      [200],
    );
    await concurrentLookupStarted.promise;
    await accept(
      automationClient().disable({
        headers,
        params: { id: installedAutomation.id },
      }),
      [200],
    );
    releaseConcurrentLookup.resolve(undefined);
    const reconfiguredAfterPause = await concurrentReconfiguration;
    expect(reconfiguredAfterPause.body.workflow.automations[0]).toMatchObject({
      id: installedAutomation.id,
      enabled: false,
      official: {
        intendedEnabled: false,
        reconciliationStatus: "current",
        parameterBindings: [{ key: "label-name", value: "Important" }],
      },
    });

    let expiringWatchCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        expiringWatchCalls++;
        return HttpResponse.json({
          historyId: "101",
          expiration: String(now() + 60_000),
        });
      }),
    );
    await accept(
      automationClient().enable({
        headers,
        params: { id: installedAutomation.id },
      }),
      [200],
    );
    expect(expiringWatchCalls).toBe(1);

    const reconciliationWatchStarted = createDeferredPromise<void>(
      context.signal,
    );
    const releaseReconciliationWatch = createDeferredPromise<void>(
      context.signal,
    );
    server.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        async () => {
          reconciliationWatchStarted.resolve(undefined);
          await releaseReconciliationWatch.promise;
          return HttpResponse.json({
            historyId: "102",
            expiration: "4102444800000",
          });
        },
      ),
    );
    const persistedReconfiguration = accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "gmail-label-trigger",
              bindings: [{ key: "label-name", value: "Follow Up" }],
            },
          ],
        },
      }),
      [200],
    );
    await reconciliationWatchStarted.promise;
    const disableDuringReconciliation = await accept(
      automationClient().disable({
        headers,
        params: { id: installedAutomation.id },
      }),
      [409],
    );
    expect(disableDuringReconciliation.body.error.message).toBe(
      "Official Workflow reconfiguration is in progress; retry shortly",
    );
    releaseReconciliationWatch.resolve(undefined);
    const reconfiguredAfterConflict = await persistedReconfiguration;
    expect(
      reconfiguredAfterConflict.body.workflow.automations[0],
    ).toMatchObject({
      id: installedAutomation.id,
      enabled: true,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "current",
        parameterBindings: [{ key: "label-name", value: "Follow Up" }],
      },
    });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [204],
    );
  });

  it("compensates a later provider-watch failure and retries without a visible partial installation", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-watch-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          scheduledBlueprint(),
          gmailBlueprint(),
        ]),
      ]),
    );

    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const actor = setup.actor;
    const { agentId } = await workflowBdd.createAgent(actor);
    let agentDeleted = false;
    onTestFinished(async () => {
      if (!agentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, agentId);
      }
      await cleanupCatalog();
    });
    mockGmailConnectorOAuth({ email: `official-${suffix}@example.test` });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let stopCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({ error: "watch failed" }, { status: 500 });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        stopCalls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const body = {
      agentId,
      blueprints: [
        {
          blueprintKey: "daily",
          bindings: [{ key: "cron-expression", value: "0 6 * * *" }],
        },
        { blueprintKey: "gmail-trigger", bindings: [] },
      ],
    };

    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body,
      }),
      [400],
    );
    const listedAfterFailure = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId },
      }),
      [200],
    );
    expect(
      listedAfterFailure.body.some((workflow) => {
        return workflow.name === definitionName;
      }),
    ).toBeFalsy();

    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({
          historyId: "100",
          expiration: "4102444800000",
        });
      }),
    );
    const retried = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body,
      }),
      [201],
    );
    expect(retried.body.workflow.automations).toHaveLength(2);
    expect(
      retried.body.workflow.automations.every((automation) => {
        return automation.enabled;
      }),
    ).toBeTruthy();
    const gmailAutomation = retried.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "gmail-trigger";
      },
    );
    if (!gmailAutomation) {
      throw new Error("Expected retried Official Gmail automation");
    }
    await accept(
      automationClient().disable({
        headers,
        params: { id: gmailAutomation.id },
      }),
      [200],
    );
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json(
          { error: "resume watch failed" },
          { status: 500 },
        );
      }),
    );
    await accept(
      automationClient().enable({
        headers,
        params: { id: gmailAutomation.id },
      }),
      [400],
    );
    const afterFailedResume = await accept(
      installationClient().get({
        headers,
        params: { workflowId: retried.body.workflow.id },
      }),
      [200],
    );
    expect(
      afterFailedResume.body.workflow.automations.find((automation) => {
        return automation.id === gmailAutomation.id;
      }),
    ).toMatchObject({
      enabled: false,
      official: {
        intendedEnabled: false,
        reconciliationStatus: "current",
      },
    });
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({
          historyId: "101",
          expiration: "4102444800000",
        });
      }),
    );
    await accept(
      automationClient().enable({
        headers,
        params: { id: gmailAutomation.id },
      }),
      [200],
    );
    const stopCallsBeforeAgentDeletion = stopCalls;
    await bdd.deleteAgent(actor, agentId);
    agentDeleted = true;
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: retried.body.workflow.id },
      }),
      [404],
    );
    expect(stopCalls).toBeGreaterThan(stopCallsBeforeAgentDeletion);
  });
});

describe.sequential("Official Workflow Run admission", () => {
  it("pins exact active and retained-retired artifacts without org shadowing", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const firstName = `api-test-run-a-${suffix}`;
    const secondName = `api-test-run-b-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(firstName, [], "accepted first revision"),
        activeDefinition(secondName, [], "accepted retained revision"),
      ]),
    );

    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId,
      name: firstName,
      visibility: "public",
    });
    const firstInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName: firstName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName: secondName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });

    const firstAccepted = await readAcceptedDefinitionFixture(firstName);
    const secondAccepted = await readAcceptedDefinitionFixture(secondName);
    const shadowStorageId = randomUUID();
    const shadowVersion = "e".repeat(64);
    await accept(
      storageClient().action({
        body: {
          action: "claim-owned-storages",
          storages: [
            {
              storage_id: shadowStorageId,
              org_id: actor.orgId,
              user_id: VOLUME_ORG_USER_ID,
              storage_name: firstAccepted.definition.artifact.storageName,
              s3_prefix: `official-shadow/${shadowStorageId}`,
            },
          ],
        },
      }),
      [200],
    );
    await accept(
      storageClient().action({
        body: {
          action: "seed-owned-storage-version",
          storage_id: shadowStorageId,
          version_id: shadowVersion,
          s3_key: `official-shadow/${shadowStorageId}/${shadowVersion}`,
          archive_size: 1,
        },
      }),
      [200],
    );
    onTestFinished(async () => {
      await accept(
        storageClient().action({
          body: {
            action: "cleanup-owned-storages",
            storage_ids: [shadowStorageId],
          },
        }),
        [200],
      );
    });

    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.heartbeatRunner(runnerGroup);
    await setOfficialWorkflowsEnabled(actor, false);
    const direct = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: firstInstallation.body.workflow.id },
      }),
      [200],
    );
    if (!direct.body.runId) {
      throw new Error("Expected direct Official Workflow Run");
    }
    const firstRunId = direct.body.runId;
    const firstState = await readOfficialWorkflowRunStateFixture(
      context,
      firstRunId,
    );
    expect(firstState.provenance?.definitions).toStrictEqual(
      [firstAccepted.definition, secondAccepted.definition]
        .map((definition) => {
          return {
            name: definition.name,
            revision: definition.revision,
            artifact: {
              orgId: SYSTEM_ORG_ID,
              userId: VOLUME_ORG_USER_ID,
              storageName: definition.artifact.storageName,
              storageId: definition.artifact.storageId,
              storageVersion: definition.artifact.storageVersion,
            },
          };
        })
        .sort((left, right) => {
          return left.name.localeCompare(right.name);
        }),
    );
    expect(firstState.storage_mounts).toStrictEqual(
      expect.arrayContaining(
        [firstAccepted.definition, secondAccepted.definition].map(
          (definition) => {
            return expect.objectContaining({
              org_id: SYSTEM_ORG_ID,
              user_id: VOLUME_ORG_USER_ID,
              name: definition.artifact.storageName,
              storage_id: definition.artifact.storageId,
              version: definition.artifact.storageVersion,
              mount_path: expect.stringMatching(`/${definition.name}$`),
            });
          },
        ),
      ),
    );
    expect(firstState.storage_mounts).not.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ storage_id: shadowStorageId }),
      ]),
    );

    await syncCatalog(
      catalog([
        activeDefinition(firstName, [], "accepted second revision"),
        retiredDefinition(secondName),
      ]),
    );
    const nextFirstAccepted = await readAcceptedDefinitionFixture(firstName);
    expect(nextFirstAccepted.definition.revision).not.toBe(
      firstAccepted.definition.revision,
    );

    const firstClaim = await runs.claimRunnerJob(firstRunId);
    if (
      !firstClaim.storageManifest ||
      !("storageMounts" in firstClaim.storageManifest)
    ) {
      throw new Error("Expected canonical Run storage manifest");
    }
    expect(firstClaim.storageManifest.storageMounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageId: firstAccepted.definition.artifact.storageId,
          versionId: firstAccepted.definition.artifact.storageVersion,
        }),
      ]),
    );
    await expect(
      readOfficialWorkflowRunStateFixture(context, firstRunId),
    ).resolves.toMatchObject({ provenance: firstState.provenance });
    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );

    const later = await runs.createRun(actor, {
      agentId,
      prompt: "resolve the newly accepted Official Definition revision",
    });
    const laterState = await readOfficialWorkflowRunStateFixture(
      context,
      later.runId,
    );
    expect(laterState.provenance?.definitions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: firstName,
          revision: nextFirstAccepted.definition.revision,
        }),
        expect.objectContaining({
          name: secondName,
          revision: secondAccepted.definition.revision,
        }),
      ]),
    );
    expect(
      laterState.provenance?.definitions.find((definition) => {
        return definition.name === firstName;
      })?.revision,
    ).not.toBe(firstAccepted.definition.revision);
    await runs.requestCancelRun(actor, later.runId, [200, 400]);
    expect(ordinaryWorkflowId).not.toBe(firstInstallation.body.workflow.id);
  });

  it("routes enabled result email through explicit, scheduled, once, and webhook Official admission", async () => {
    installCatalogStorageFixture();
    mockEnv("VM0_WEB_URL", "https://api.vm0.ai");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-producers-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          loopBlueprint(true),
          onceBlueprint(true),
          webhookBlueprint(true),
        ]),
      ]),
    );
    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
    });
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    await selectBuiltInDefaultModel(actor);
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    configureResultEmailRecipient(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const atTime = new Date(now() + 60_000).toISOString();
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            {
              blueprintKey: "pulse",
              bindings: [{ key: "interval-seconds", value: 60 }],
            },
            {
              blueprintKey: "one-shot",
              bindings: [
                { key: "at-time", value: atTime },
                {
                  key: "callback-url",
                  value: "https://example.test/official-callback",
                },
                { key: "correlation-id", value: randomUUID() },
              ],
            },
            { blueprintKey: "webhook-trigger", bindings: [] },
          ],
        },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();

    const automations = new Map(
      installed.body.workflow.automations.flatMap((automation) => {
        return automation.official
          ? [[automation.official.blueprintKey, automation] as const]
          : [];
      }),
    );
    const loopAutomation = automations.get("pulse");
    const onceAutomation = automations.get("one-shot");
    const webhookAutomation = automations.get("webhook-trigger");
    if (!loopAutomation || !onceAutomation || !webhookAutomation) {
      throw new Error("Expected all Official Workflow producer automations");
    }

    const explicit = await accept(
      automationClient().run({
        headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: loopAutomation.id },
      }),
      [201],
    );
    if (!explicit.body.runId) {
      throw new Error("Expected explicit Official Automation Run");
    }
    const producerRuns: {
      readonly runId: string;
      readonly automationId: string;
      readonly publicBrand: "vm0" | "okou";
    }[] = [
      {
        runId: explicit.body.runId,
        automationId: loopAutomation.id,
        publicBrand: "okou",
      },
    ];
    await completeSuccessfulRun(
      runnerGroup,
      explicit.body.runId,
      "Explicit Official result",
    );

    const scheduled = await withMockNowForTest(now() + 120_000, async () => {
      return await accept(
        automationExecutionClient().execute({
          body: { automation_id: loopAutomation.id },
        }),
        [200],
      );
    });
    expect(scheduled.body.executed).toBe(1);
    const scheduledRun = await readLatestWorkflowAutomationRunFixture(
      context,
      loopAutomation.id,
    );
    if (!scheduledRun || scheduledRun.runId === explicit.body.runId) {
      throw new Error("Expected a distinct scheduled Official Automation Run");
    }
    producerRuns.push({
      runId: scheduledRun.runId,
      automationId: loopAutomation.id,
      publicBrand: "vm0",
    });
    await completeSuccessfulRun(
      runnerGroup,
      scheduledRun.runId,
      "Scheduled Official result",
    );

    const once = await withMockNowForTest(now() + 120_000, async () => {
      return await accept(
        automationExecutionClient().execute({
          body: { automation_id: onceAutomation.id },
        }),
        [200],
      );
    });
    expect(once.body.executed).toBe(1);
    const onceRun = await readLatestWorkflowAutomationRunFixture(
      context,
      onceAutomation.id,
    );
    if (!onceRun) {
      throw new Error("Expected once Official Automation Run");
    }
    producerRuns.push({
      runId: onceRun.runId,
      automationId: onceAutomation.id,
      publicBrand: "vm0",
    });
    await completeSuccessfulRun(
      runnerGroup,
      onceRun.runId,
      "Once Official result",
    );

    if (
      webhookAutomation.kind !== "event" ||
      webhookAutomation.eventType !== "webhook-received"
    ) {
      throw new Error("Expected Official webhook automation");
    }
    const webhookCredentials = await accept(
      automationClient().revealWebhookSecret({
        headers,
        params: { id: webhookAutomation.id },
        body: undefined,
      }),
      [200],
    );
    const webhook = await postOfficialWorkflowWebhook({
      webhookUrl: webhookCredentials.body.webhookUrl,
      secret: webhookCredentials.body.webhookSecret,
      body: JSON.stringify({ event: "official-p2-regression" }),
    });
    expect(webhook).toMatchObject({
      status: 200,
      body: { success: true, duplicate: false },
    });
    await expect
      .poll(async () => {
        return (
          await readLatestWorkflowAutomationRunFixture(
            context,
            webhookAutomation.id,
          )
        )?.runId;
      })
      .toEqual(expect.any(String));
    const webhookRun = await readLatestWorkflowAutomationRunFixture(
      context,
      webhookAutomation.id,
    );
    if (!webhookRun) {
      throw new Error("Expected Official webhook Automation Run");
    }
    producerRuns.push({
      runId: webhookRun.runId,
      automationId: webhookAutomation.id,
      publicBrand: "vm0",
    });
    await completeSuccessfulRun(
      runnerGroup,
      webhookRun.runId,
      "Event Official result",
    );

    const accepted = await readAcceptedDefinitionFixture(definitionName);
    for (const producer of producerRuns) {
      const state = await readOfficialWorkflowRunStateFixture(
        context,
        producer.runId,
      );
      expect(state.model_provider).toBe("built-in");
      expect(state.provenance?.definitions).toStrictEqual([
        expect.objectContaining({
          name: definitionName,
          revision: accepted.definition.revision,
        }),
      ]);
      expect(state.storage_mounts).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            org_id: SYSTEM_ORG_ID,
            user_id: VOLUME_ORG_USER_ID,
            storage_id: accepted.definition.artifact.storageId,
            version: accepted.definition.artifact.storageVersion,
          }),
        ]),
      );
      const source = await outbox.findSourceState({
        sourceRunId: producer.runId,
        sourceWorkflowAutomationId: producer.automationId,
      });
      expect(source.claim).not.toBeNull();
      expect(source.items).toStrictEqual([
        expect.objectContaining({
          public_brand: producer.publicBrand,
          source_run_id: producer.runId,
          source_workflow_automation_id: producer.automationId,
          status: "pending",
          template: expect.objectContaining({
            template: "official-automation-result",
          }),
        }),
      ]);
    }
  });

  it("preserves session and agent-token brands across Official result callback retry", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-brand",
      true,
    );
    const sessionRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!sessionRun.body.runId) {
      throw new Error("Expected session Official Automation Run");
    }
    await completeSuccessfulRun(
      scenario.runnerGroup,
      sessionRun.body.runId,
      "Session-brand result",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: sessionRun.body.runId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toMatchObject({
      items: [{ public_brand: "okou" }],
      claim: { source_run_id: sessionRun.body.runId },
    });

    const agentToken = runs.okouTokenForRunWithCapabilities(
      scenario.actor,
      sessionRun.body.runId,
      ["agent:write"],
      "vm0",
    );
    const agentRun = await accept(
      automationClient().run({
        headers: { authorization: `Bearer ${agentToken}` },
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!agentRun.body.runId) {
      throw new Error("Expected agent-token Official Automation Run");
    }

    mockEnv("RESEND_FROM_DOMAIN", undefined);
    await completeSuccessfulRun(
      scenario.runnerGroup,
      agentRun.body.runId,
      "Agent-token retry result",
    );
    expect(
      (await runs.readRun(scenario.actor, agentRun.body.runId)).status,
    ).toBe("completed");
    await expect(
      outbox.findSourceState({
        sourceRunId: agentRun.body.runId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });

    mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
    const redrive = await accept(
      automationExecutionClient().dispatchCallbacks({
        body: {
          run_id: agentRun.body.runId,
          status: "completed",
          dispatch_count: 8,
        },
      }),
      [200],
    );
    expect(redrive.body.successful_callbacks).toBeGreaterThan(0);
    const source = await outbox.findSourceState({
      sourceRunId: agentRun.body.runId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(source.claim).not.toBeNull();
    expect(source.items).toStrictEqual([
      expect.objectContaining({
        public_brand: "vm0",
        source_run_id: agentRun.body.runId,
        source_workflow_automation_id: scenario.automation.id,
      }),
    ]);
  });

  it("uses the immutable launch snapshot across Official result-email reconfiguration", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-reconfigure",
      true,
    );
    const enabledRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!enabledRun.body.runId) {
      throw new Error("Expected enabled-at-launch Official Automation Run");
    }

    await syncCatalog(
      catalog([
        activeDefinition(scenario.definitionName, [loopBlueprint(false)]),
      ]),
    );
    await accept(
      installationClient().reconfigure({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
        body: {
          blueprints: [{ blueprintKey: "pulse", bindings: [] }],
        },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, scenario.automation.id),
    ).resolves.toMatchObject({ officialResultEmailEnabled: false });
    await completeSuccessfulRun(
      scenario.runnerGroup,
      enabledRun.body.runId,
      "Enabled launch survives disablement",
    );
    const enabledSource = await outbox.findSourceState({
      sourceRunId: enabledRun.body.runId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(enabledSource.claim).not.toBeNull();
    expect(enabledSource.items).toStrictEqual([
      expect.objectContaining({ public_brand: "okou" }),
    ]);

    const disabledRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!disabledRun.body.runId) {
      throw new Error("Expected disabled-at-launch Official Automation Run");
    }
    await syncCatalog(
      catalog([
        activeDefinition(scenario.definitionName, [loopBlueprint(true)]),
      ]),
    );
    await accept(
      installationClient().reconfigure({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
        body: {
          blueprints: [{ blueprintKey: "pulse", bindings: [] }],
        },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, scenario.automation.id),
    ).resolves.toMatchObject({ officialResultEmailEnabled: true });
    await completeSuccessfulRun(
      scenario.runnerGroup,
      disabledRun.body.runId,
      "Disabled launch stays ineligible",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: disabledRun.body.runId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });
  });

  it("retains the Official result source through uninstall, TTL cleanup, and concurrent redrive", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-uninstall",
      true,
    );
    const launched = await accept(
      automationClient().run({
        headers: scenario.headers,
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!launched.body.runId) {
      throw new Error("Expected pre-uninstall Official Automation Run");
    }
    const launchedRunId = launched.body.runId;
    const beforeUninstall = await readOfficialWorkflowRunStateFixture(
      context,
      launchedRunId,
    );
    expect(beforeUninstall.provenance?.definitions).toHaveLength(1);
    expect(beforeUninstall.storage_mounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ org_id: SYSTEM_ORG_ID }),
      ]),
    );

    await accept(
      installationClient().uninstall({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
      }),
      [204],
    );
    await completeSuccessfulRun(
      scenario.runnerGroup,
      launchedRunId,
      "Post-uninstall result",
    );
    expect((await runs.readRun(scenario.actor, launchedRunId)).status).toBe(
      "completed",
    );
    const beforeCleanup = await outbox.findSourceState({
      sourceRunId: launchedRunId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    const originalItem = beforeCleanup.items[0];
    if (!beforeCleanup.claim || !originalItem) {
      throw new Error("Expected post-uninstall Official result source");
    }

    await withMockNowForTest(now() + 16 * 60 * 1000, async () => {
      await expect(outbox.cleanupExpiredItems([originalItem.id])).resolves.toBe(
        1,
      );
    });
    await expect(
      outbox.findSourceState({
        sourceRunId: launchedRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: beforeCleanup.claim });

    const redrives = await Promise.all(
      Array.from({ length: 8 }, async () => {
        return await accept(
          automationExecutionClient().interruptResultEmailCallback({
            body: { run_id: launchedRunId },
          }),
          [200],
        );
      }),
    );
    expect(
      redrives.every((response) => {
        return response.body.skipped;
      }),
    ).toBeTruthy();
    await expect(
      outbox.findSourceState({
        sourceRunId: launchedRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: beforeCleanup.claim });
  });

  it("creates no Run for stale or unverifiable Official admission state", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-stale-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [loopBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId,
      name: `api-test-stale-ordinary-${suffix}`,
    });
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            {
              blueprintKey: "pulse",
              bindings: [{ key: "interval-seconds", value: 60 }],
            },
          ],
        },
      }),
      [201],
    );
    const ordinaryAutomation = await accept(
      automationClient().create({
        headers,
        params: { workflowId: ordinaryWorkflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const automation = installed.body.workflow.automations[0];
    if (!automation?.official) {
      throw new Error("Expected Official Automation state");
    }
    const originalFingerprint = automation.official.appliedFingerprint;
    const before = await runs.listAgentRuns(actor, {
      agent: agentId,
      limit: 100,
    });
    const beforeRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const crossTableMismatches = [
      {
        automationId: automation.id,
        mismatchedWorkflowId: ordinaryWorkflowId,
        restoredWorkflowId: installed.body.workflow.id,
      },
      {
        automationId: ordinaryAutomation.body.id,
        mismatchedWorkflowId: installed.body.workflow.id,
        restoredWorkflowId: ordinaryWorkflowId,
      },
    ];

    for (const mismatch of crossTableMismatches) {
      await retargetWorkflowAutomationFixture(
        context,
        mismatch.automationId,
        mismatch.mismatchedWorkflowId,
      );
      await assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture(
        context,
        mismatch.automationId,
        installed.body.workflow.id,
      );
      await accept(
        automationClient().run({
          headers,
          params: { id: mismatch.automationId },
        }),
        [409],
      );
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(beforeRunFamily);
      await retargetWorkflowAutomationFixture(
        context,
        mismatch.automationId,
        mismatch.restoredWorkflowId,
      );
    }

    for (const status of [
      "reconciling",
      "needs_reconfiguration",
      "failed",
    ] as const) {
      await setOfficialWorkflowAutomationAdmissionStateFixture(
        context,
        automation.id,
        status,
      );
      await accept(
        automationClient().run({
          headers,
          params: { id: automation.id },
        }),
        [409],
      );
    }

    await setOfficialWorkflowAutomationAdmissionStateFixture(
      context,
      automation.id,
      "current",
      "0".repeat(64),
    );
    await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [409],
    );
    await setOfficialWorkflowAutomationAdmissionStateFixture(
      context,
      automation.id,
      "current",
      originalFingerprint,
    );

    const changedBlueprint: OfficialWorkflowBlueprint = {
      ...loopBlueprint(),
      desiredState: {
        ...loopBlueprint().desiredState,
        autonomyBudget: 5,
      },
    };
    await syncCatalog(
      catalog([activeDefinition(definitionName, [changedBlueprint])]),
    );
    await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [409],
    );

    await cleanupCatalog();
    await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [409],
    );
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automation.id),
    ).resolves.toBeNull();
    const after = await runs.listAgentRuns(actor, {
      agent: agentId,
      limit: 100,
    });
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("does not downgrade persisted Official catalog invariant failures to stale admission", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-run-invariant-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cleanupCatalog();
      await bdd.deleteAgent(actor, agentId);
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const before = await readAgentRunFamilyCountsFixture(context, agentId);

    await corruptOfficialWorkflowRevisionPayloadFixture(
      context,
      definitionName,
    );
    await expect(
      workflowClient().run({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);
  });

  it("keeps pre-bootstrap Official source requirements fail closed without changing ordinary Workflow runs", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-bootstrap-${suffix}`;
    const ordinaryName = `api-test-ordinary-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [loopBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
    });
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId,
      name: ordinaryName,
    });
    const install = async () => {
      return await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: {
            agentId,
            blueprints: [
              {
                blueprintKey: "pulse",
                bindings: [{ key: "interval-seconds", value: 60 }],
              },
            ],
          },
        }),
        [201],
      );
    };
    let installation = await install();
    onTestFinished(async () => {
      installCatalogStorageFixture();
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const initialCounts = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const directGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const directRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await directGate.read()).bootstrap_requirement;
      })
      .toStrictEqual({
        workflow_ids: [installation.body.workflow.id],
        queue_first_kind: "user_message",
        workflow_automation_id: null,
      });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await directGate.release();
    await accept(directRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialCounts);

    installation = await install();
    const automation = installation.body.workflow.automations.find(
      (candidate) => {
        return candidate.official?.blueprintKey === "pulse";
      },
    );
    if (!automation) {
      throw new Error("Expected Official Automation for bootstrap race");
    }
    const automationGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const automationRequest = automationClient().run({
      headers,
      params: { id: automation.id },
    });
    await expect
      .poll(async () => {
        return (await automationGate.read()).bootstrap_requirement;
      })
      .toStrictEqual({
        workflow_ids: [installation.body.workflow.id],
        queue_first_kind: "automation_event",
        workflow_automation_id: automation.id,
      });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await automationGate.release();
    await accept(automationRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialCounts);

    const ordinaryGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const ordinary = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: ordinaryWorkflowId },
      }),
      [200],
    );
    await expect(ordinaryGate.read()).resolves.toMatchObject({ arrivals: 0 });
    await ordinaryGate.release();
    if (!ordinary.body.runId) {
      throw new Error("Expected ordinary Workflow Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, ordinary.body.runId),
    ).resolves.toMatchObject({
      status: "pending",
      provenance: null,
      runner_job_count: 1,
    });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual({
      run_count: initialCounts.run_count + 1,
      callback_count: initialCounts.callback_count + 1,
      runner_job_count: initialCounts.runner_job_count + 1,
      launch_queue_count: initialCounts.launch_queue_count,
    });
    await runs.requestCancelRun(actor, ordinary.body.runId, [200, 400]);
  });

  it("preserves and terminalizes a queued Official source claim before draining the ordinary message behind it", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-queued-source-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installation = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const first = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    if (!first.body.runId) {
      throw new Error("Expected first Official Workflow Run");
    }
    const firstRunId = first.body.runId;
    const firstClaim = await runs.claimRunnerJob(firstRunId);
    const beforeQueuedEvents = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    const beforeQueuedEventIds = new Set(
      beforeQueuedEvents.events.map((event) => {
        return event.id;
      }),
    );
    const beforeQueuedRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const queuedOfficial = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    expect(queuedOfficial.body).toMatchObject({
      chatThreadId: first.body.chatThreadId,
      runId: null,
    });
    const afterOfficialQueued = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    const officialQueuedEvent = afterOfficialQueued.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        !beforeQueuedEventIds.has(event.id)
      );
    });
    if (!officialQueuedEvent) {
      throw new Error("Expected persisted Official queued message");
    }

    const ordinaryPrompt = `ordinary queued control ${suffix}`;
    const ordinaryQueuedEventId = randomUUID();
    const queuedOrdinary = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.body.chatThreadId,
        prompt: ordinaryPrompt,
        clientEventId: ordinaryQueuedEventId,
      },
      [201],
    );
    if ("error" in queuedOrdinary.body) {
      throw new Error(queuedOrdinary.body.error.message);
    }
    expect(queuedOrdinary.body.runId).toBeNull();

    const previousReaderBeforeResolution =
      await readChatEventRowsAsPreviousApiFixture(
        context,
        first.body.chatThreadId,
      );
    const previousReaderOfficialSource = previousReaderBeforeResolution.find(
      (event) => {
        return event.id === officialQueuedEvent.id;
      },
    );
    if (!previousReaderOfficialSource) {
      throw new Error("Previous API reader missed queued Official input");
    }
    expect(previousReaderOfficialSource).toMatchObject({
      event_type: "input.prompt",
      revokes_event_id: null,
    });
    expect(previousReaderOfficialSource.payload_keys).not.toContain(
      "requiredOfficialWorkflowIds",
    );

    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    await expect
      .poll(async () => {
        const events = await chat.listThreadEvents(
          actor,
          first.body.chatThreadId,
        );
        return events.events.filter((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === officialQueuedEvent.id &&
            event.error === "conflict"
          );
        }).length;
      })
      .toBe(1);
    const afterOfficialFailure = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    expect(
      afterOfficialFailure.events.filter((event) => {
        return (
          event.eventType === "input.rejected" &&
          event.revokesEventId === officialQueuedEvent.id &&
          event.error === "conflict"
        );
      }),
    ).toHaveLength(1);
    expect(
      afterOfficialFailure.events.filter((event) => {
        return (
          event.eventType === "output.error" &&
          event.error === "conflict" &&
          typeof event.content === "string" &&
          event.content.length > 0
        );
      }),
    ).toHaveLength(1);
    const previousReaderAfterResolution =
      await readChatEventRowsAsPreviousApiFixture(
        context,
        first.body.chatThreadId,
      );
    expect(
      previousReaderAfterResolution.find((event) => {
        return event.id === officialQueuedEvent.id;
      }),
    ).toMatchObject(previousReaderOfficialSource);
    expect(
      previousReaderAfterResolution.filter((event) => {
        return (
          event.event_type === "input.rejected" &&
          event.revokes_event_id === officialQueuedEvent.id
        );
      }),
    ).toHaveLength(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeQueuedRunFamily);

    const staleAt = now() + 10 * 60 * 1000;
    await withMockNowForTest(staleAt, async () => {
      await reconcileStaleQueuedMessages(first.body.chatThreadId);
    });
    await flushWaitUntilForTest();
    let ordinaryRunId: string | undefined;
    await expect
      .poll(async () => {
        const listed = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        ordinaryRunId = listed.runs.find((run) => {
          return run.prompt === ordinaryPrompt;
        })?.id;
        return ordinaryRunId;
      })
      .toStrictEqual(expect.any(String));
    if (!ordinaryRunId) {
      throw new Error("Expected ordinary queued control Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, ordinaryRunId),
    ).resolves.toMatchObject({
      provenance: null,
      runner_job_count: 1,
    });
    const expectedRunFamilyAfterOrdinary = {
      run_count: beforeQueuedRunFamily.run_count + 1,
      callback_count: beforeQueuedRunFamily.callback_count + 1,
      runner_job_count: beforeQueuedRunFamily.runner_job_count + 1,
      launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
    };
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(expectedRunFamilyAfterOrdinary);

    const ordinaryClaim = await runs.claimRunnerJob(ordinaryRunId);
    await webhooks.requestAgentComplete(
      { runId: ordinaryRunId, exitCode: 1 },
      { authorization: `Bearer ${ordinaryClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const beforeLaterDrain = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );
    await withMockNowForTest(staleAt + 10 * 60 * 1000, async () => {
      await reconcileStaleQueuedMessages(first.body.chatThreadId);
    });
    await flushWaitUntilForTest();

    const afterLaterDrain = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    expect(
      afterLaterDrain.events.filter((event) => {
        return (
          event.eventType === "input.rejected" &&
          event.revokesEventId === officialQueuedEvent.id &&
          event.error === "conflict"
        );
      }),
    ).toHaveLength(1);
    expect(
      afterLaterDrain.events.filter((event) => {
        return (
          event.eventType === "output.error" &&
          event.error === "conflict" &&
          typeof event.content === "string" &&
          event.content.length > 0
        );
      }),
    ).toHaveLength(1);
    expect(
      afterLaterDrain.events.filter((event) => {
        return (
          event.revokesEventId === ordinaryQueuedEventId &&
          event.runId === ordinaryRunId
        );
      }),
    ).toHaveLength(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeLaterDrain);
  });

  it("keeps a queued Official source claim retryable across an unexpected persisted-revision failure", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-queued-retry-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installation = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const first = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    if (!first.body.runId) {
      throw new Error("Expected first Official Workflow Run");
    }
    const firstRunId = first.body.runId;
    const firstClaim = await runs.claimRunnerJob(firstRunId);
    const beforeQueueEvents = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    const beforeQueueEventIds = new Set(
      beforeQueueEvents.events.map((event) => {
        return event.id;
      }),
    );
    const beforeQueuedRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const queued = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    expect(queued.body.runId).toBeNull();
    const afterQueued = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    const queuedEvent = afterQueued.events.find((event) => {
      return (
        event.eventType === "input.prompt" && !beforeQueueEventIds.has(event.id)
      );
    });
    if (!queuedEvent) {
      throw new Error("Expected persisted retryable Official queued message");
    }

    await corruptOfficialWorkflowRevisionPayloadFixture(
      context,
      definitionName,
    );
    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const afterUnexpectedFailure = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    expect(
      afterUnexpectedFailure.events.filter((event) => {
        return event.revokesEventId === queuedEvent.id;
      }),
    ).toHaveLength(0);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual({
      run_count: beforeQueuedRunFamily.run_count,
      callback_count: beforeQueuedRunFamily.callback_count,
      runner_job_count: beforeQueuedRunFamily.runner_job_count,
      launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
    });

    await cleanupCatalog();
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [],
          "Execute the repaired accepted Definition content.",
        ),
      ]),
    );
    const repaired = await readAcceptedDefinitionFixture(definitionName);
    await withMockNowForTest(now() + 10 * 60 * 1000, async () => {
      await reconcileStaleQueuedMessages(first.body.chatThreadId);
    });
    await flushWaitUntilForTest();

    let retriedRunId: string | undefined;
    await expect
      .poll(async () => {
        const listed = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        retriedRunId = listed.runs.find((run) => {
          return run.id !== firstRunId;
        })?.id;
        return retriedRunId;
      })
      .toStrictEqual(expect.any(String));
    if (!retriedRunId) {
      throw new Error("Expected retried Official queued Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, retriedRunId),
    ).resolves.toMatchObject({
      provenance: {
        definitions: [
          {
            name: definitionName,
            revision: repaired.definition.revision,
          },
        ],
      },
      runner_job_count: 1,
    });
    const afterRetry = await chat.listThreadEvents(
      actor,
      first.body.chatThreadId,
    );
    expect(
      afterRetry.events.filter((event) => {
        return (
          event.revokesEventId === queuedEvent.id &&
          event.runId === retriedRunId
        );
      }),
    ).toHaveLength(1);
    const retriedClaim = await runs.claimRunnerJob(retriedRunId);
    await webhooks.requestAgentComplete(
      { runId: retriedRunId, exitCode: 1 },
      { authorization: `Bearer ${retriedClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  });

  it("checks uninstall before both successful and retained-failure Run insertion paths", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-uninstall-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const install = async () => {
      return await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: { agentId, blueprints: [] },
        }),
        [201],
      );
    };
    let installation = await install();
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    const initialRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const normalGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const normalRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await normalGate.read()).arrivals;
      })
      .toBe(1);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await normalGate.release();
    await accept(normalRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialRunFamily);

    installation = await install();
    const acceptedDefinition =
      await readAcceptedDefinitionFixture(definitionName);
    await accept(
      storageClient().action({
        body: {
          action: "cleanup-owned-storage-cache",
          storage_id: acceptedDefinition.definition.artifact.storageId,
        },
      }),
      [200],
    );
    context.mocks.s3.getSignedUrl.mockRejectedValue(
      new Error("unrelated presign failure after Official resolution"),
    );
    const failedGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const failedRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await failedGate.read()).arrivals;
      })
      .toBe(1);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await failedGate.release();
    await accept(failedRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialRunFamily);

    installation = await install();
    const retainedFailure = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    if (!retainedFailure.body.runId) {
      throw new Error("Expected retained unrelated-failure Run");
    }
    const failedState = await readOfficialWorkflowRunStateFixture(
      context,
      retainedFailure.body.runId,
    );
    expect(failedState).toMatchObject({
      status: "failed",
      runner_job_count: 0,
      callback_count: 1,
      storage_mounts: null,
      provenance: {
        definitions: [expect.objectContaining({ name: definitionName })],
      },
    });
  });

  it("serializes Run-first uninstall after exact Run persistence", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-run-first-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installation = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const gate = await installOfficialWorkflowRunGateFixture(
      context,
      "final-admission",
    );
    const runRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return await gate.read();
      })
      .toMatchObject({ arrivals: 1, shared_catalog_holder_count: 1 });
    const uninstallRequest = accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await expect
      .poll(async () => {
        return (await gate.read()).blocked_waiter_count;
      })
      .toBe(1);
    await gate.release();
    const run = await accept(runRequest, [200]);
    await uninstallRequest;
    if (!run.body.runId) {
      throw new Error("Expected Run-first Official Workflow Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, run.body.runId),
    ).resolves.toMatchObject({
      status: "pending",
      provenance: {
        definitions: [expect.objectContaining({ name: definitionName })],
      },
    });
    await runs.requestCancelRun(actor, run.body.runId, [200, 400]);
  });

  it("admits cross-org Runs concurrently under the shared catalog lock and rejects a superseded observation", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-shared-lock-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision one"),
      ]),
    );
    const original = await readAcceptedDefinitionFixture(definitionName);
    const firstSetup = await workflowBdd.setupWorkflowOrg();
    const secondSetup = await workflowBdd.setupWorkflowOrg();
    const firstActor = firstSetup.actor;
    const secondActor = secondSetup.actor;
    if (!firstActor.orgId || !secondActor.orgId) {
      throw new Error("Expected organization-scoped actors");
    }
    const firstAgent = await workflowBdd.createAgent(firstActor);
    const secondAgent = await workflowBdd.createAgent(secondActor);
    await setOfficialWorkflowsEnabled(firstActor, true);
    await setOfficialWorkflowsEnabled(secondActor, true);
    const firstHeaders = authHeaders(firstActor);
    const firstInstallation = await accept(
      officialClient().install({
        headers: firstHeaders,
        params: { definitionName },
        body: { agentId: firstAgent.agentId, blueprints: [] },
      }),
      [201],
    );
    const secondHeaders = authHeaders(secondActor);
    await accept(
      officialClient().install({
        headers: secondHeaders,
        params: { definitionName },
        body: { agentId: secondAgent.agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(firstActor, firstAgent.agentId);
      await bdd.deleteAgent(secondActor, secondAgent.agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const sharedGate = await installOfficialWorkflowRunGateFixture(
      context,
      "final-admission",
    );
    const firstRunPromise = runs.createRun(firstActor, {
      agentId: firstAgent.agentId,
      prompt: "hold the first shared Official admission",
    });
    await expect
      .poll(async () => {
        return (await sharedGate.read()).arrivals;
      })
      .toBe(1);
    const secondRunPromise = runs.createRun(secondActor, {
      agentId: secondAgent.agentId,
      prompt: "hold the second shared Official admission",
    });
    await expect
      .poll(async () => {
        return await sharedGate.read();
      })
      .toMatchObject({ arrivals: 2, shared_catalog_holder_count: 2 });

    const activation = syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision two"),
      ]),
    );
    await expect
      .poll(async () => {
        return (await sharedGate.read()).exclusive_catalog_waiter_count;
      })
      .toBe(1);
    await sharedGate.release();
    const [firstRun, secondRun] = await Promise.all([
      firstRunPromise,
      secondRunPromise,
    ]);
    await activation;
    for (const runId of [firstRun.runId, secondRun.runId]) {
      await expect(
        readOfficialWorkflowRunStateFixture(context, runId),
      ).resolves.toMatchObject({
        provenance: {
          definitions: [
            expect.objectContaining({
              name: definitionName,
              revision: original.definition.revision,
            }),
          ],
        },
      });
    }

    const beforeRace = await readAgentRunFamilyCountsFixture(
      context,
      firstAgent.agentId,
    );
    const raceGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const staleRequest = workflowClient().run({
      headers: authHeaders(firstActor),
      params: { workflowId: firstInstallation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await raceGate.read()).arrivals;
      })
      .toBe(1);
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision three"),
      ]),
    );
    await raceGate.release();
    await accept(staleRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, firstAgent.agentId),
    ).resolves.toStrictEqual(beforeRace);
    await runs.requestCancelRun(firstActor, firstRun.runId, [200, 400]);
    await runs.requestCancelRun(secondActor, secondRun.runId, [200, 400]);
  });
});
