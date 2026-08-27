import { randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
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
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readLatestWorkflowAutomationRunFixture,
  readWorkflowAutomationAutonomyFixture,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { createCronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { officialWorkflowRoutes } from "../official-workflows";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const bdd = createBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const mocks = createRouteMocks(context);
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

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions,
  };
}

function scheduledBlueprint(): OfficialWorkflowBlueprint {
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
    runtime: {},
  };
}

function loopBlueprint(): OfficialWorkflowBlueprint {
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
    runtime: {},
  };
}

function onceBlueprint(): OfficialWorkflowBlueprint {
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
    runtime: {},
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
    runtime: {},
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
    runtime: {},
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
          scheduledBlueprint(),
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
    ).resolves.toMatchObject({ autonomyBudget: 4, enabled: true });

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
      workflowClient().run({
        headers,
        params: { workflowId: firstWorkflowId },
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
    const runNow = await accept(
      automationClient().run({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [409],
    );
    expect(runNow.body.error.message).toBe(
      "Official Workflows are not executable until shared Definition execution is available",
    );
    await expect(
      readLatestWorkflowAutomationRunFixture(context, dailyAutomation.id),
    ).resolves.toBeNull();

    const pulseAutomation = installed.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "pulse";
      },
    );
    if (!pulseAutomation) {
      throw new Error("Expected Official Workflow loop automation");
    }
    const scheduledExecution = await accept(
      automationExecutionClient().execute({
        body: { automation_id: pulseAutomation.id },
      }),
      [200],
    );
    expect(scheduledExecution.body).toMatchObject({ executed: 0, skipped: 1 });
    await expect(
      readLatestWorkflowAutomationRunFixture(context, pulseAutomation.id),
    ).resolves.toBeNull();

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
    ).resolves.toMatchObject({ autonomyBudget: 4, enabled: false });

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
    ).resolves.toMatchObject({ autonomyBudget: 4, enabled: true });

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
