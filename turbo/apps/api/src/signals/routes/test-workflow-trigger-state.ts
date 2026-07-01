import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  getCustomSkillStorageName,
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import {
  type TestWorkflowTriggerStateActionBody,
  testWorkflowTriggerStateContract,
} from "@vm0/api-contracts/contracts/test-workflow-trigger-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { gmailWatchStates } from "@vm0/db/schema/gmail-event";
import {
  googleCalendarEventSnapshots,
  googleCalendarProcessedEvents,
  googleCalendarWatchStates,
} from "@vm0/db/schema/google-calendar-event";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { userCache } from "@vm0/db/schema/user-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowGithubProcessedEvents,
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { and, desc, eq, inArray } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { encryptStoredSecretValue } from "../services/crypto.utils";
import type { RouteEntry } from "../route-entry";
import { now } from "../../lib/time";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testWorkflowTriggerStateContract.action);

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

type WorkflowTriggerStateAction = TestWorkflowTriggerStateActionBody["action"];
type WorkflowTriggerStateActionResponse =
  | ReturnType<typeof actionOk>
  | ReturnType<typeof actionBadRequest>;
type WorkflowTriggerStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<WorkflowTriggerStateActionResponse>;

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(body, key) ?? undefined;
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  return typeof body[key] === "boolean" ? body[key] : defaultValue;
}

function readDate(body: Record<string, unknown>, key: string): Date | null {
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readNullableDate(
  body: Record<string, unknown>,
  key: string,
): Date | null {
  if (body[key] === null) {
    return null;
  }
  return readDate(body, key);
}

function readScheduleType(
  body: Record<string, unknown>,
): ZeroWorkflowScheduleType | null {
  const value = body.schedule_type;
  return value === "cron" || value === "loop" || value === "once"
    ? value
    : null;
}

function readVisibility(body: Record<string, unknown>): "public" | "private" {
  return body.visibility === "private" ? "private" : "public";
}

function readStringArray(
  body: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    return typeof item === "string" && item.length > 0 ? [item] : [];
  });
}

function readConnectorType(
  body: Record<string, unknown>,
): "gmail" | "google-calendar" | null {
  const value = body.connector_type;
  return value === "gmail" || value === "google-calendar" ? value : null;
}

async function seedScenarioForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readOptionalString(body, "org_id") ?? `org_${randomUUID()}`;
  const userId = readOptionalString(body, "user_id") ?? `user_${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID().replaceAll("-", "");
  const workflowName = readOptionalString(body, "workflow_name") ?? "workflow";
  const agentName = readOptionalString(body, "agent_name") ?? "workflow-agent";

  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  signal.throwIfAborted();
  await db
    .insert(orgMembersCache)
    .values({ orgId, userId, role: "member" })
    .onConflictDoNothing();
  signal.throwIfAborted();
  await db
    .insert(orgMembersMetadata)
    .values({ orgId, userId, timezone: null })
    .onConflictDoNothing();
  signal.throwIfAborted();
  await db
    .insert(userCache)
    .values({ userId, email: `${userId}@example.com` })
    .onConflictDoNothing();
  signal.throwIfAborted();

  await db.insert(agentComposes).values({
    id: agentId,
    userId,
    orgId,
    name: agentName,
  });
  signal.throwIfAborted();
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentId,
    content: {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
    createdBy: userId,
  });
  signal.throwIfAborted();
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, agentId));
  signal.throwIfAborted();
  await db.insert(zeroAgents).values({
    id: agentId,
    orgId,
    owner: userId,
    name: agentName,
    displayName: "Scheduler Agent",
    visibility: "public",
  });
  signal.throwIfAborted();
  const [workflow] = await db
    .insert(zeroWorkflows)
    .values({
      orgId,
      agentId,
      name: workflowName,
      visibility: "public",
      ownerUserId: userId,
      displayName: null,
      description: null,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: zeroWorkflows.id });
  signal.throwIfAborted();
  if (!workflow) {
    return actionBadRequest("failed to seed workflow");
  }

  return actionOk({
    fixture: {
      org_id: orgId,
      user_id: userId,
      agent_id: agentId,
      workflow_id: workflow.id,
      workflow_name: workflowName,
    },
  });
}

async function seedTriggerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const agentId = readString(body, "agent_id");
  const workflowId = readString(body, "workflow_id");
  const scheduleType = readScheduleType(body);
  if (!orgId || !userId || !agentId || !workflowId || !scheduleType) {
    return actionBadRequest(
      "org_id, user_id, agent_id, workflow_id, and schedule_type are required",
    );
  }

  let threadId: string | null = null;
  if (readBoolean(body, "bind_thread", true)) {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: agentId,
        title: readOptionalString(body, "thread_title") ?? "trigger thread",
      })
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    if (!thread) {
      return actionBadRequest("failed to seed trigger thread");
    }
    threadId = thread.id;
    await db.insert(workflowUserTriggerThreads).values({
      orgId,
      userId,
      workflowId,
      chatThreadId: threadId,
    });
    signal.throwIfAborted();
  }

  const nextRunAt = readNullableDate(body, "next_run_at");
  const [trigger] = await db
    .insert(zeroWorkflowTriggers)
    .values({
      orgId,
      workflowId,
      ownerUserId: userId,
      kind: "schedule",
      scheduleType,
      cronExpression:
        scheduleType === "cron"
          ? (readOptionalString(body, "cron_expression") ?? "0 9 * * *")
          : null,
      intervalSeconds:
        scheduleType === "loop"
          ? (readNumber(body, "interval_seconds") ?? 300)
          : null,
      atTime: scheduleType === "once" ? nextRunAt : null,
      timezone: readOptionalString(body, "timezone") ?? "UTC",
      enabled: readBoolean(body, "enabled", true),
      nextRunAt,
      consecutiveFailures: readNumber(body, "consecutive_failures") ?? 0,
      lastRunId: readOptionalString(body, "last_run_id") ?? null,
    })
    .returning({ id: zeroWorkflowTriggers.id });
  signal.throwIfAborted();
  if (!trigger) {
    return actionBadRequest("failed to seed trigger");
  }
  return actionOk({ trigger_id: trigger.id, thread_id: threadId });
}

async function seedWorkflowsFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readOptionalString(body, "org_id") ?? `org_${randomUUID()}`;
  const userId = readOptionalString(body, "user_id") ?? `user_${randomUUID()}`;
  await db
    .insert(orgMetadata)
    .values({
      orgId,
      tier: readOptionalString(body, "tier") ?? "free",
      credits: readNumber(body, "credits") ?? 10_000,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  return actionOk({
    fixture: {
      org_id: orgId,
      user_id: userId,
    },
  });
}

async function seedWorkflowForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const agentId = readString(body, "agent_id");
  const name = readString(body, "name");
  if (!orgId || !userId || !agentId || !name) {
    return actionBadRequest("org_id, user_id, agent_id, and name are required");
  }
  const [workflow] = await db
    .insert(zeroWorkflows)
    .values({
      orgId,
      agentId,
      name,
      visibility: readVisibility(body),
      instruction: readOptionalString(body, "instruction") ?? null,
      ownerUserId: userId,
      displayName: readOptionalString(body, "display_name") ?? null,
      description: readOptionalString(body, "description") ?? null,
      createdBy: userId,
      updatedBy: readOptionalString(body, "updated_by_user_id") ?? userId,
    })
    .returning({ id: zeroWorkflows.id });
  signal.throwIfAborted();
  if (!workflow) {
    return actionBadRequest("failed to seed workflow");
  }
  return actionOk({ workflow_id: workflow.id });
}

async function seedWorkflowStorageForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const workflowId = readString(body, "workflow_id");
  const s3Key = readString(body, "s3_key");
  const headVersionId = readString(body, "head_version_id");
  if (!orgId || !userId || !workflowId || !s3Key || !headVersionId) {
    return actionBadRequest(
      "org_id, user_id, workflow_id, s3_key, and head_version_id are required",
    );
  }
  const storageId = randomUUID();
  const storageName = getCustomSkillStorageName(workflowId);
  await db.insert(storages).values({
    id: storageId,
    userId: VOLUME_ORG_USER_ID,
    name: storageName,
    type: readOptionalString(body, "type") ?? "volume",
    orgId,
    s3Prefix: `orgs/${orgId}/${storageName}`,
  });
  signal.throwIfAborted();
  await db.insert(storageVersions).values({
    id: headVersionId,
    storageId,
    s3Key,
    createdBy: userId,
  });
  signal.throwIfAborted();
  await db
    .update(storages)
    .set({ headVersionId })
    .where(eq(storages.id, storageId));
  signal.throwIfAborted();
  return actionOk({ storage_id: storageId });
}

async function seedInstructionsStorageForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const agentName = readString(body, "agent_name");
  const s3Key = readString(body, "s3_key");
  if (!orgId || !userId || !agentName || !s3Key) {
    return actionBadRequest(
      "org_id, user_id, agent_name, and s3_key are required",
    );
  }
  const storageId = randomUUID();
  const storageName = getInstructionsStorageName(agentName);
  const headVersionId =
    readOptionalString(body, "head_version_id") ?? `head-${randomUUID()}`;
  await db.insert(storages).values({
    id: storageId,
    userId: VOLUME_ORG_USER_ID,
    name: storageName,
    type: "volume",
    orgId,
    s3Prefix: `orgs/${orgId}/${storageName}`,
  });
  signal.throwIfAborted();
  await db.insert(storageVersions).values({
    id: headVersionId,
    storageId,
    s3Key,
    createdBy: userId,
  });
  signal.throwIfAborted();
  await db
    .update(storages)
    .set({ headVersionId })
    .where(eq(storages.id, storageId));
  signal.throwIfAborted();
  return actionOk({ storage_id: storageId, head_version_id: headVersionId });
}

async function seedAgentWorkflowForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  if (!orgId || !userId) {
    return actionBadRequest("org_id and user_id are required");
  }

  const agentId = randomUUID();
  const versionId = randomUUID().replaceAll("-", "");
  const agentName =
    readOptionalString(body, "agent_name") ??
    `workflow-agent-${randomUUID().slice(0, 8)}`;
  const workflowName = readOptionalString(body, "workflow_name");
  const workflowNames = [
    ...new Set([
      ...readStringArray(body, "workflow_names"),
      ...(workflowName ? [workflowName] : []),
    ]),
  ];
  const visibility = readVisibility(body);

  await db.insert(agentComposes).values({
    id: agentId,
    userId,
    orgId,
    name: agentName,
  });
  signal.throwIfAborted();
  if (
    body.compose_content !== undefined ||
    readBoolean(body, "with_compose_version", true)
  ) {
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: agentId,
      content: body.compose_content ?? {
        version: "1",
        agents: {
          [agentName]: {
            framework: readOptionalString(body, "framework") ?? "claude-code",
            ...(readOptionalString(body, "instructions")
              ? { instructions: readOptionalString(body, "instructions") }
              : {}),
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
      createdBy: userId,
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, agentId));
    signal.throwIfAborted();
  }

  if (readBoolean(body, "with_zero_agent", true)) {
    await db
      .insert(zeroAgents)
      .values({
        id: agentId,
        orgId,
        owner: userId,
        name: agentName,
        displayName: readOptionalString(body, "display_name") ?? null,
        description: readOptionalString(body, "description") ?? null,
        sound: readOptionalString(body, "sound") ?? null,
        avatarUrl: readOptionalString(body, "avatar_url") ?? null,
        modelProviderId: readOptionalString(body, "model_provider_id") ?? null,
        selectedModel: readOptionalString(body, "selected_model") ?? null,
        preferPersonalProvider: readBoolean(
          body,
          "prefer_personal_provider",
          false,
        ),
        visibility,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
  }

  const workflows =
    workflowNames.length > 0
      ? await db
          .insert(zeroWorkflows)
          .values(
            workflowNames.map((name) => {
              return {
                orgId,
                agentId,
                name,
                visibility: "public" as const,
                ownerUserId: userId,
                displayName: null,
                description: null,
                createdBy: userId,
                updatedBy: userId,
              };
            }),
          )
          .onConflictDoNothing()
          .returning({ id: zeroWorkflows.id, name: zeroWorkflows.name })
      : [];
  signal.throwIfAborted();
  const workflowIdsByName = Object.fromEntries(
    workflows.map((workflow) => {
      return [workflow.name, workflow.id] as const;
    }),
  );

  return actionOk({
    agent_id: agentId,
    name: agentName,
    workflow_id: workflowName ? workflowIdsByName[workflowName] : undefined,
    workflow_name: workflowName,
    workflow_ids_by_name: workflowIdsByName,
  });
}

async function seedConnectorForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const connectorType = readConnectorType(body);
  if (!orgId || !userId || !connectorType) {
    return actionBadRequest("org_id, user_id, and connector_type are required");
  }
  const isGmail = connectorType === "gmail";
  const externalEmail =
    readOptionalString(body, "external_email") ??
    (isGmail ? "workflow-user@example.com" : "calendar-user@example.com");
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId,
      userId,
      type: connectorType,
      authMethod: "oauth",
      externalEmail,
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      oauthScopes: JSON.stringify(
        isGmail
          ? ["https://www.googleapis.com/auth/gmail.modify"]
          : ["https://www.googleapis.com/auth/calendar"],
      ),
    })
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  if (!connector) {
    return actionBadRequest("failed to seed connector");
  }

  await db.insert(secrets).values({
    orgId,
    userId,
    name: isGmail ? "GMAIL_ACCESS_TOKEN" : "GOOGLE_CALENDAR_ACCESS_TOKEN",
    encryptedValue: await encryptStoredSecretValue(
      readOptionalString(body, "access_token") ??
        (isGmail ? "gmail-access-token" : "calendar-access-token"),
    ),
    type: "connector",
  });
  signal.throwIfAborted();
  return actionOk({ connector_id: connector.id });
}

async function seedGithubInstallationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const composeId = readString(body, "compose_id");
  if (!orgId || !composeId) {
    return actionBadRequest("org_id and compose_id are required");
  }
  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId:
        readOptionalString(body, "installation_id") ?? `github-${randomUUID()}`,
      status: "active",
      orgId,
      targetType: "Organization",
      targetId: "12345",
      targetName: "vm0-ai",
      defaultComposeId: composeId,
    })
    .returning({ id: githubInstallations.id });
  signal.throwIfAborted();
  if (!installation) {
    return actionBadRequest("failed to seed GitHub installation");
  }
  return actionOk({ installation_id: installation.id });
}

async function seedGithubUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const installationId = readString(body, "installation_id");
  const userId = readString(body, "user_id");
  if (!installationId || !userId) {
    return actionBadRequest("installation_id and user_id are required");
  }
  await db.insert(githubUserLinks).values({
    installationId,
    vm0UserId: userId,
    githubUserId: readOptionalString(body, "github_user_id") ?? "101",
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedGmailAuthorizationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const agentId = readString(body, "agent_id");
  if (!orgId || !userId || !agentId) {
    return actionBadRequest("org_id, user_id, and agent_id are required");
  }
  await db.insert(connectors).values({
    orgId,
    userId,
    type: "gmail",
    authMethod: "oauth",
    externalEmail: "trigger-user@example.com",
    tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    oauthScopes: JSON.stringify([
      "https://www.googleapis.com/auth/gmail.modify",
    ]),
  });
  signal.throwIfAborted();
  await db.insert(secrets).values({
    orgId,
    userId,
    name: "GMAIL_ACCESS_TOKEN",
    encryptedValue: "test-gmail-access-token",
    type: "connector",
  });
  signal.throwIfAborted();
  await db.insert(userConnectors).values({
    orgId,
    userId,
    agentId,
    connectorType: "gmail",
  });
  signal.throwIfAborted();
  await db.insert(userPermissionGrants).values({
    orgId,
    userId,
    agentId,
    connectorRef: "gmail",
    permission: "messages.write",
    action: "allow",
  });
  signal.throwIfAborted();
  return actionOk();
}

async function setOwnerTimezoneForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const timezone = readString(body, "timezone");
  if (!orgId || !userId || !timezone) {
    return actionBadRequest("org_id, user_id, and timezone are required");
  }
  await db
    .update(orgMembersMetadata)
    .set({ timezone })
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function seedActiveRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  const userId = readString(body, "user_id");
  const agentId = readString(body, "agent_id");
  if (!orgId || !userId || !agentId) {
    return actionBadRequest("org_id, user_id, and agent_id are required");
  }
  const [session] = await db
    .insert(agentSessions)
    .values({ orgId, userId, agentComposeId: agentId })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    return actionBadRequest("failed to seed active run session");
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId,
      userId,
      sessionId: session.id,
      status: "running",
      prompt: "active",
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed active run");
  }
  return actionOk({ run_id: run.id });
}

async function setTriggerRunStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const triggerId = readString(body, "trigger_id");
  if (!triggerId) {
    return actionBadRequest("trigger_id is required");
  }
  await db
    .update(zeroWorkflowTriggers)
    .set({
      lastRunId: readOptionalString(body, "last_run_id") ?? undefined,
      lastRunAt: readDate(body, "last_run_at"),
      nextRunAt: readNullableDate(body, "next_run_at"),
    })
    .where(eq(zeroWorkflowTriggers.id, triggerId));
  signal.throwIfAborted();
  return actionOk();
}

async function getTriggerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const triggerId = readString(body, "trigger_id");
  if (!triggerId) {
    return actionBadRequest("trigger_id is required");
  }
  const [trigger] = await db
    .select({
      id: zeroWorkflowTriggers.id,
      enabled: zeroWorkflowTriggers.enabled,
      nextRunAt: zeroWorkflowTriggers.nextRunAt,
      lastRunId: zeroWorkflowTriggers.lastRunId,
      lastRunAt: zeroWorkflowTriggers.lastRunAt,
      consecutiveFailures: zeroWorkflowTriggers.consecutiveFailures,
    })
    .from(zeroWorkflowTriggers)
    .where(eq(zeroWorkflowTriggers.id, triggerId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ trigger: trigger ?? null });
}

async function getRunStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const triggerId = readString(body, "trigger_id");
  const runId = readOptionalString(body, "run_id");
  if (!triggerId && !runId) {
    return actionBadRequest("trigger_id or run_id is required");
  }
  const runConditions = runId
    ? [eq(zeroRuns.id, runId)]
    : [eq(zeroRuns.workflowTriggerId, triggerId!)];
  const runs = await db
    .select({
      id: zeroRuns.id,
      triggerSource: zeroRuns.triggerSource,
      triggerBrief: zeroRuns.triggerBrief,
      workflowTriggerId: zeroRuns.workflowTriggerId,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(and(...runConditions))
    .orderBy(desc(agentRuns.createdAt));
  signal.throwIfAborted();
  const selectedRunId = runId ?? runs[0]?.id;
  if (!selectedRunId) {
    return actionOk({
      runs,
      run: null,
      callbacks: [],
      job: null,
      messages: [],
      binding: null,
    });
  }
  const [[agentRun], callbacks, [job], messages, [binding]] = await Promise.all(
    [
      db
        .select({
          id: agentRuns.id,
          prompt: agentRuns.prompt,
          status: agentRuns.status,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, selectedRunId))
        .limit(1),
      db
        .select({
          internalKind: agentRunCallbacks.internalKind,
          url: agentRunCallbacks.url,
          payload: agentRunCallbacks.payload,
        })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.runId, selectedRunId)),
      db
        .select({ executionContext: runnerJobQueue.executionContext })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, selectedRunId))
        .limit(1),
      db
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          runId: chatMessages.runId,
        })
        .from(chatMessages)
        .where(eq(chatMessages.runId, selectedRunId)),
      triggerId
        ? db
            .select({
              chatThreadId: workflowUserTriggerThreads.chatThreadId,
            })
            .from(workflowUserTriggerThreads)
            .innerJoin(
              zeroWorkflowTriggers,
              eq(
                zeroWorkflowTriggers.workflowId,
                workflowUserTriggerThreads.workflowId,
              ),
            )
            .where(eq(zeroWorkflowTriggers.id, triggerId))
            .limit(1)
        : Promise.resolve([]),
    ],
  );
  signal.throwIfAborted();
  return actionOk({
    runs,
    run: agentRun ?? null,
    callbacks,
    job: job ?? null,
    messages,
    binding: binding ?? null,
  });
}

async function getWorkflowStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const workflowId = readString(body, "workflow_id");
  if (!workflowId) {
    return actionBadRequest("workflow_id is required");
  }
  const [binding] = await db
    .select({ chatThreadId: workflowUserTriggerThreads.chatThreadId })
    .from(workflowUserTriggerThreads)
    .where(eq(workflowUserTriggerThreads.workflowId, workflowId))
    .limit(1);
  signal.throwIfAborted();
  const triggers = await db
    .select({
      id: zeroWorkflowTriggers.id,
      kind: zeroWorkflowTriggers.kind,
      lastRunId: zeroWorkflowTriggers.lastRunId,
      lastRunAt: zeroWorkflowTriggers.lastRunAt,
      nextRunAt: zeroWorkflowTriggers.nextRunAt,
    })
    .from(zeroWorkflowTriggers)
    .where(eq(zeroWorkflowTriggers.workflowId, workflowId));
  signal.throwIfAborted();
  const [workflow] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(eq(zeroWorkflows.id, workflowId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    workflow: workflow ?? null,
    binding: binding ?? null,
    triggers,
  });
}

async function getGmailWatchForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const connectorId = readString(body, "connector_id");
  if (!connectorId) {
    return actionBadRequest("connector_id is required");
  }
  const watches = await db
    .select({
      id: gmailWatchStates.id,
      orgId: gmailWatchStates.orgId,
      userId: gmailWatchStates.userId,
      emailAddress: gmailWatchStates.emailAddress,
      topicName: gmailWatchStates.topicName,
      lastHistoryId: gmailWatchStates.lastHistoryId,
      needsRewatch: gmailWatchStates.needsRewatch,
    })
    .from(gmailWatchStates)
    .where(eq(gmailWatchStates.connectorId, connectorId));
  signal.throwIfAborted();
  return actionOk({ watches });
}

async function getGoogleCalendarWatchForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const connectorId = readString(body, "connector_id");
  if (!connectorId) {
    return actionBadRequest("connector_id is required");
  }
  const watches = await db
    .select({
      id: googleCalendarWatchStates.id,
      orgId: googleCalendarWatchStates.orgId,
      userId: googleCalendarWatchStates.userId,
      calendarId: googleCalendarWatchStates.calendarId,
      channelId: googleCalendarWatchStates.channelId,
      channelToken: googleCalendarWatchStates.channelToken,
      resourceId: googleCalendarWatchStates.resourceId,
      syncToken: googleCalendarWatchStates.syncToken,
      needsRewatch: googleCalendarWatchStates.needsRewatch,
    })
    .from(googleCalendarWatchStates)
    .where(eq(googleCalendarWatchStates.connectorId, connectorId));
  signal.throwIfAborted();
  const watchIds = watches.map((watch) => {
    return watch.id;
  });
  const snapshots =
    watchIds.length > 0
      ? await db
          .select({
            watchStateId: googleCalendarEventSnapshots.watchStateId,
            calendarEventId: googleCalendarEventSnapshots.calendarEventId,
            summary: googleCalendarEventSnapshots.summary,
          })
          .from(googleCalendarEventSnapshots)
          .where(inArray(googleCalendarEventSnapshots.watchStateId, watchIds))
      : [];
  signal.throwIfAborted();
  const triggerId = readOptionalString(body, "trigger_id");
  const processed =
    watchIds.length > 0
      ? await db
          .select({
            watchStateId: googleCalendarProcessedEvents.watchStateId,
            triggerId: googleCalendarProcessedEvents.triggerId,
            calendarEventId: googleCalendarProcessedEvents.calendarEventId,
            eventChangeKey: googleCalendarProcessedEvents.eventChangeKey,
          })
          .from(googleCalendarProcessedEvents)
          .where(
            and(
              inArray(googleCalendarProcessedEvents.watchStateId, watchIds),
              triggerId
                ? eq(googleCalendarProcessedEvents.triggerId, triggerId)
                : undefined,
            ),
          )
      : [];
  signal.throwIfAborted();
  return actionOk({ watches, snapshots, processed });
}

async function getChatThreadForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const threadId = readString(body, "thread_id");
  if (!threadId) {
    return actionBadRequest("thread_id is required");
  }
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  signal.throwIfAborted();
  const messages = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, threadId));
  signal.throwIfAborted();
  return actionOk({ thread: thread ?? null, messages });
}

async function getGithubProcessedEventsForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const triggerId = readString(body, "trigger_id");
  if (!triggerId) {
    return actionBadRequest("trigger_id is required");
  }
  const processed = await db
    .select({
      githubDeliveryId: zeroWorkflowGithubProcessedEvents.githubDeliveryId,
      action: zeroWorkflowGithubProcessedEvents.action,
      labelNameNormalized:
        zeroWorkflowGithubProcessedEvents.labelNameNormalized,
    })
    .from(zeroWorkflowGithubProcessedEvents)
    .where(eq(zeroWorkflowGithubProcessedEvents.triggerId, triggerId))
    .orderBy(zeroWorkflowGithubProcessedEvents.githubDeliveryId);
  signal.throwIfAborted();
  return actionOk({ processed });
}

async function deleteScenarioForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readString(body, "org_id");
  if (!orgId) {
    return actionBadRequest("org_id is required");
  }
  const memberRows = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.orgId, orgId));
  signal.throwIfAborted();
  const userIds = memberRows.map((row) => {
    return row.userId;
  });
  const composeRows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.orgId, orgId));
  signal.throwIfAborted();
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    signal.throwIfAborted();
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    signal.throwIfAborted();
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    signal.throwIfAborted();
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  const threadRows = await db
    .select({ id: workflowUserTriggerThreads.chatThreadId })
    .from(workflowUserTriggerThreads)
    .where(eq(workflowUserTriggerThreads.orgId, orgId));
  signal.throwIfAborted();
  const threadIds = threadRows.flatMap((row) => {
    return row.id ? [row.id] : [];
  });
  if (threadIds.length > 0) {
    await db
      .delete(chatMessages)
      .where(inArray(chatMessages.chatThreadId, threadIds));
    signal.throwIfAborted();
  }
  await db
    .delete(workflowUserTriggerThreads)
    .where(eq(workflowUserTriggerThreads.orgId, orgId));
  signal.throwIfAborted();
  if (threadIds.length > 0) {
    await db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
    signal.throwIfAborted();
  }
  await db
    .delete(zeroWorkflowTriggers)
    .where(eq(zeroWorkflowTriggers.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(storages).where(eq(storages.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(zeroWorkflows).where(eq(zeroWorkflows.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(connectors).where(eq(connectors.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(userConnectors).where(eq(userConnectors.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(userPermissionGrants)
    .where(eq(userPermissionGrants.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(zeroAgents).where(eq(zeroAgents.orgId, orgId));
  signal.throwIfAborted();
  if (composeIds.length > 0) {
    await db
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
    signal.throwIfAborted();
  }
  await db.delete(agentComposes).where(eq(agentComposes.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(agentSessions).where(eq(agentSessions.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  if (userIds.length > 0) {
    await db.delete(userCache).where(inArray(userCache.userId, userIds));
    signal.throwIfAborted();
  }
  return actionOk();
}

const workflowTriggerStateActionHandlers = {
  "seed-scenario": seedScenarioForAction,
  "delete-scenario": deleteScenarioForAction,
  "seed-workflows-fixture": seedWorkflowsFixtureForAction,
  "seed-agent-workflow": seedAgentWorkflowForAction,
  "seed-workflow": seedWorkflowForAction,
  "seed-workflow-storage": seedWorkflowStorageForAction,
  "seed-instructions-storage": seedInstructionsStorageForAction,
  "seed-trigger": seedTriggerForAction,
  "seed-connector": seedConnectorForAction,
  "seed-gmail-authorization": seedGmailAuthorizationForAction,
  "seed-github-installation": seedGithubInstallationForAction,
  "seed-github-user-link": seedGithubUserLinkForAction,
  "set-owner-timezone": setOwnerTimezoneForAction,
  "seed-active-run": seedActiveRunForAction,
  "set-trigger-run-state": setTriggerRunStateForAction,
  "get-trigger": getTriggerForAction,
  "get-run-state": getRunStateForAction,
  "get-workflow-state": getWorkflowStateForAction,
  "get-gmail-watch": getGmailWatchForAction,
  "get-google-calendar-watch": getGoogleCalendarWatchForAction,
  "get-chat-thread": getChatThreadForAction,
  "get-github-processed-events": getGithubProcessedEventsForAction,
} satisfies Record<
  WorkflowTriggerStateAction,
  WorkflowTriggerStateActionHandler
>;

const mutateTestWorkflowTriggerState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data as Record<string, unknown>;
    const db = set(writeDb$);
    const handler = workflowTriggerStateActionHandlers[bodyResult.data.action];
    return await handler(db, body, signal);
  },
);

export const testWorkflowTriggerStateRoutes: readonly RouteEntry[] = [
  {
    route: testWorkflowTriggerStateContract.action,
    handler: mutateTestWorkflowTriggerState$,
  },
];
