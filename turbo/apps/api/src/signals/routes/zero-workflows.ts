import { command, computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowVisibilityContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  getAllFeatureStates,
  isFeatureEnabled,
} from "@vm0/core/feature-switch";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@vm0/core/zero-workflow-skill";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflowWebhookAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, ne } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { publishChatThreadWorkflowsChangedSafely } from "../external/realtime";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "../services/api-dispatch-timing.service";
import {
  conflict,
  connectorReadinessTimeout,
  notFound,
  payloadTooLarge,
  providerUnavailable,
} from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { uploadVolumeServerSide$ } from "../services/storage-volume-upload.service";
import { deleteZeroWorkflow$ } from "../services/zero-workflow-delete.service";
import { zeroWorkflowDetail } from "../services/zero-workflow-detail.service";
import {
  ensureWorkflowUserAutomationThread,
  loadWorkflowUserAutomationThreadId,
} from "../services/zero-workflow-user-automation-thread.service";
import { updateZeroWorkflow$ } from "../services/zero-workflow-update.service";
import { detectWorkflowConnectorReadiness$ } from "../services/zero-workflow-connector-readiness.service";
import { createUserMessageDocument } from "../services/zero-chat-user-message.service";
import { loadWorkflowVolumeFiles } from "../services/zero-workflow-volume.service";
import {
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
} from "../services/workflow-webhook-automation.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { settle } from "../utils";
import {
  loadVisibleWorkflowById,
  requireWorkflowPermission,
  workflowSummary,
  zeroWorkflowList,
  type WorkflowAgentInfo,
  type WorkflowMember,
  type WorkflowRow,
} from "../services/zero-workflow-data.service";
import type { RouteEntry } from "../route-entry";
import { sendNormalEvent$ } from "./zero-chat-events";

const log = logger("api:zero:workflow-connector-readiness");

const workflowReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const workflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}): WorkflowMember {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function workflowNotFound(workflowId: string) {
  return notFound(`Workflow not found: ${workflowId}`);
}

interface ConfigurableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
}

async function loadAgentForConfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<ConfigurableAgent | null> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
    )
    .limit(1);

  return agent ?? null;
}

function requireAgentWritePermission(
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
  action: string,
) {
  return requireAgentPermission(agent.owner, member, action, {
    visibility: agent.visibility,
  });
}

function requireVisibleAgentForPrivateWorkflowCreate(
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
) {
  if (agent.visibility === "public" || agent.owner === member.userId) {
    return null;
  }

  return forbidden(
    "Only the private agent owner can create private workflows on this agent",
  );
}

async function publicWorkflowSlugExists(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.agentId, args.agentId),
        eq(zeroWorkflows.name, args.name),
        eq(zeroWorkflows.visibility, "public"),
        args.excludeWorkflowId
          ? ne(zeroWorkflows.id, args.excludeWorkflowId)
          : undefined,
      ),
    )
    .limit(1);

  return existing !== undefined;
}

async function requirePublicWorkflowSlugAvailable(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
) {
  const exists = await publicWorkflowSlugExists(db, args);
  return exists
    ? conflict(
        `A public workflow named "/${args.name}" already exists on this agent. Rename this workflow or keep it private.`,
      )
    : null;
}

async function privateWorkflowSlugExists(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.agentId, args.agentId),
        eq(zeroWorkflows.ownerUserId, args.ownerUserId),
        eq(zeroWorkflows.name, args.name),
        eq(zeroWorkflows.visibility, "private"),
        args.excludeWorkflowId
          ? ne(zeroWorkflows.id, args.excludeWorkflowId)
          : undefined,
      ),
    )
    .limit(1);

  return existing !== undefined;
}

async function requirePrivateWorkflowSlugAvailable(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
) {
  const exists = await privateWorkflowSlugExists(db, args);
  return exists
    ? conflict(
        `You already have a private workflow named "/${args.name}" on this agent. Rename the existing workflow or choose a different name.`,
      )
    : null;
}

async function requireWorkflowSlugAvailableForVisibility(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly visibility: "public" | "private";
    readonly excludeWorkflowId?: string;
  },
) {
  if (args.visibility === "public") {
    return await requirePublicWorkflowSlugAvailable(db, args);
  }

  return await requirePrivateWorkflowSlugAvailable(db, args);
}

async function loadMatchingWorkflowCreationThreadId(
  db: Db,
  args: {
    readonly userId: string;
    readonly agentId: string;
    readonly chatThreadId: string;
  },
): Promise<string | null> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentComposeId, args.agentId),
      ),
    )
    .limit(1)
    .for("update");

  return thread?.id ?? null;
}

async function publishCreatedWorkflow(
  userId: string,
  chatThreadId: string | null,
  signal: AbortSignal,
): Promise<void> {
  if (chatThreadId) {
    await publishChatThreadWorkflowsChangedSafely(userId, chatThreadId);
    signal.throwIfAborted();
  }
}

const createWorkflowBody$ = bodyResultOf(
  zeroWorkflowsCollectionContract.create,
);
const updateWorkflowBody$ = bodyResultOf(zeroWorkflowsDetailContract.update);
const copyWorkflowBody$ = bodyResultOf(zeroWorkflowsDetailContract.copy);

const listWorkflowsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroWorkflowsCollectionContract.list));
  const workflows = await get(
    zeroWorkflowList({
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      ...(query.agentId ? { agentId: query.agentId } : {}),
    }),
  );
  return { status: 200 as const, body: [...workflows] };
});

const createWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const bodyResult = await get(createWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const visibility = body.visibility ?? "private";

    if (SEED_SKILLS.includes(body.name)) {
      return conflict(
        `Workflow name "${body.name}" conflicts with a built-in workflow`,
      );
    }

    const writeDb = set(writeDb$);
    const agent = await loadAgentForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentId: body.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return notFound(`Agent not found: ${body.agentId}`);
    }

    const permissionError =
      visibility === "public"
        ? requireAgentWritePermission(
            agent,
            member,
            "create workflows on this agent",
          )
        : requireVisibleAgentForPrivateWorkflowCreate(agent, member);
    if (permissionError) {
      return permissionError;
    }

    const slugError = await requireWorkflowSlugAvailableForVisibility(writeDb, {
      orgId: auth.orgId,
      agentId: agent.id,
      ownerUserId: auth.userId,
      name: body.name,
      visibility,
    });
    signal.throwIfAborted();
    if (slugError) {
      return slugError;
    }

    const currentTime = nowDate();
    const inserted = await writeDb.transaction(async (tx) => {
      const [workflow] = await tx
        .insert(zeroWorkflows)
        .values({
          orgId: auth.orgId,
          agentId: agent.id,
          name: body.name,
          visibility,
          instruction: body.instruction ?? null,
          ownerUserId: auth.userId,
          displayName: body.displayName ?? null,
          description: body.description ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning({ id: zeroWorkflows.id });

      if (!workflow) {
        return null;
      }

      const chatThreadId = body.chatThreadId
        ? await loadMatchingWorkflowCreationThreadId(tx, {
            userId: auth.userId,
            agentId: agent.id,
            chatThreadId: body.chatThreadId,
          })
        : null;

      if (chatThreadId) {
        await tx.insert(workflowUserAutomationThreads).values({
          orgId: auth.orgId,
          userId: auth.userId,
          workflowId: workflow.id,
          chatThreadId,
          createdAt: currentTime,
          updatedAt: currentTime,
        });
      }

      return { workflow, chatThreadId };
    });
    signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Failed to create workflow");
    }

    const skillMd = synthesizeWorkflowSkillMd({
      name: body.name,
      description: body.description ?? null,
      instruction: body.instruction ?? null,
    });
    await set(
      uploadVolumeServerSide$,
      {
        orgId: auth.orgId,
        storageName: getCustomSkillStorageName(inserted.workflow.id),
        files: [
          { path: "SKILL.md", content: skillMd },
          ...(body.files ?? []).map((file) => {
            return { path: file.path, content: file.content };
          }),
        ],
      },
      signal,
    );
    signal.throwIfAborted();

    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: inserted.workflow.id,
    });
    signal.throwIfAborted();
    if (!visible) {
      throw new Error(`Created workflow not found: ${inserted.workflow.id}`);
    }

    const summary = workflowSummary({
      workflow: visible.workflow,
      agent: visible.agent,
      member,
    });
    await publishCreatedWorkflow(auth.userId, inserted.chatThreadId, signal);
    return { status: 201 as const, body: summary };
  },
);

const getWorkflowDetailInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroWorkflowsDetailContract.get));
  const result = await get(
    zeroWorkflowDetail({
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
    }),
  );
  if (!result) {
    return workflowNotFound(params.workflowId);
  }
  return { status: 200 as const, body: result };
});

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "TimeoutError"
  );
}

const connectorReadinessInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroWorkflowsDetailContract.connectorReadiness),
    );
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const featureContext = {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    };
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.WorkflowConnectorReadiness,
        featureContext,
      )
    ) {
      return forbidden("Workflow connector readiness is disabled");
    }

    const visible = await loadVisibleWorkflowById(get(db$), {
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }

    const detected = await settle(
      set(
        detectWorkflowConnectorReadiness$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          agentId: visible.workflow.agentId,
          workflowId: visible.workflow.id,
          workflow: {
            name: visible.workflow.name,
            description: visible.workflow.description,
            instruction: visible.workflow.instruction,
          },
          featureStates: getAllFeatureStates(featureContext),
        },
        signal,
      ),
      signal,
    );
    if (!detected.ok) {
      if (isTimeoutError(detected.error)) {
        return connectorReadinessTimeout(
          "Connector readiness check timed out. Please retry.",
        );
      }
      log.warn("Workflow connector readiness check failed", {
        workflowId: visible.workflow.id,
        error:
          detected.error instanceof Error
            ? detected.error.message
            : String(detected.error),
      });
      return providerUnavailable(
        "Connector readiness check failed. Please retry.",
      );
    }
    const result = detected.value;
    if (!result.ok) {
      return payloadTooLarge(result.message);
    }
    return { status: 200 as const, body: result.response };
  },
);

const updateWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowsDetailContract.update));
    const bodyResult = await get(updateWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }

    const permissionError = requireWorkflowPermission(
      visible.workflow,
      visible.agent,
      member,
      "update workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    if (
      bodyResult.data.name !== undefined &&
      bodyResult.data.name !== visible.workflow.name
    ) {
      if (SEED_SKILLS.includes(bodyResult.data.name)) {
        return conflict(
          `Workflow name "${bodyResult.data.name}" conflicts with a built-in workflow`,
        );
      }

      const slugConflict = await requireWorkflowSlugAvailableForVisibility(
        writeDb,
        {
          orgId: auth.orgId,
          agentId: visible.workflow.agentId,
          ownerUserId: visible.workflow.ownerUserId,
          name: bodyResult.data.name,
          visibility: visible.workflow.visibility,
          excludeWorkflowId: visible.workflow.id,
        },
      );
      signal.throwIfAborted();
      if (slugConflict) {
        return slugConflict;
      }
    }

    await set(
      updateZeroWorkflow$,
      {
        workflow: visible.workflow,
        body: bodyResult.data,
        updatedByUserId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    const detail = await get(
      zeroWorkflowDetail({
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      }),
    );
    signal.throwIfAborted();
    if (!detail) {
      return workflowNotFound(params.workflowId);
    }
    return { status: 200 as const, body: detail };
  },
);

const deleteWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowsDetailContract.delete));

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }

    const permissionError = requireWorkflowPermission(
      visible.workflow,
      visible.agent,
      member,
      "delete workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    const deleted = await set(
      deleteZeroWorkflow$,
      { orgId: auth.orgId, workflowId: params.workflowId },
      signal,
    );
    signal.throwIfAborted();

    if (!deleted) {
      return workflowNotFound(params.workflowId);
    }

    return { status: 204 as const, body: undefined };
  },
);

type WorkflowCopyTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CopyWorkflowRuntimeArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceWorkflow: WorkflowRow;
  readonly targetAgentId: string;
  readonly currentTime: Date;
}

interface CopyWorkflowScopedRowsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceWorkflowId: string;
  readonly targetWorkflowId: string;
  readonly currentTime: Date;
}

interface CopyWorkflowAutomationRowsArgs extends CopyWorkflowScopedRowsArgs {
  readonly targetAgentId: string;
  readonly workflowTitle: string;
}

async function insertCopiedWorkflowRow(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowRuntimeArgs,
): Promise<{ readonly id: string } | undefined> {
  const [workflow] = await tx
    .insert(zeroWorkflows)
    .values({
      orgId: args.orgId,
      agentId: args.targetAgentId,
      name: args.sourceWorkflow.name,
      visibility: "private",
      instruction: args.sourceWorkflow.instruction,
      ownerUserId: args.userId,
      displayName: args.sourceWorkflow.displayName,
      description: args.sourceWorkflow.description,
      createdBy: args.userId,
      updatedBy: args.userId,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: zeroWorkflows.id });
  return workflow;
}

async function copyWorkflowWebhookAutomationConfig(
  tx: WorkflowCopyTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sourceAutomationId: string;
    readonly targetAutomationId: string;
    readonly currentTime: Date;
  },
): Promise<void> {
  const [sourceWebhook] = await tx
    .select({
      encryptedSecret: zeroWorkflowWebhookAutomations.encryptedSecret,
      secretLastFour: zeroWorkflowWebhookAutomations.secretLastFour,
    })
    .from(zeroWorkflowWebhookAutomations)
    .where(
      eq(zeroWorkflowWebhookAutomations.automationId, args.sourceAutomationId),
    )
    .limit(1);
  const token = mintWorkflowWebhookToken();
  let encryptedSecret: string;
  let secretLastFour: string;
  if (sourceWebhook) {
    encryptedSecret = sourceWebhook.encryptedSecret;
    secretLastFour = sourceWebhook.secretLastFour;
  } else {
    const secret = mintWorkflowWebhookSecret();
    encryptedSecret = await encryptWorkflowWebhookSecret(secret, {
      orgId: args.orgId,
      userId: args.userId,
    });
    secretLastFour = secret.slice(-4);
  }

  await tx.insert(zeroWorkflowWebhookAutomations).values({
    automationId: args.targetAutomationId,
    tokenHash: hashWorkflowWebhookToken(token),
    encryptedToken: await encryptWorkflowWebhookToken(token, {
      orgId: args.orgId,
      userId: args.userId,
    }),
    encryptedSecret,
    secretLastFour,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
}

async function copyWorkflowAutomationRow(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowScopedRowsArgs & {
    readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
  },
): Promise<void> {
  const [copiedAutomation] = await tx
    .insert(zeroWorkflowAutomations)
    .values({
      orgId: args.orgId,
      workflowId: args.targetWorkflowId,
      ownerUserId: args.userId,
      kind: args.automation.kind,
      eventType: args.automation.eventType,
      eventConfig: args.automation.eventConfig,
      scheduleType: args.automation.scheduleType,
      cronExpression: args.automation.cronExpression,
      intervalSeconds: args.automation.intervalSeconds,
      atTime: args.automation.atTime,
      timezone: args.automation.timezone,
      enabled: args.automation.enabled,
      nextRunAt: args.automation.nextRunAt,
      lastRunAt: null,
      lastRunId: null,
      consecutiveFailures: 0,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: zeroWorkflowAutomations.id });
  if (!copiedAutomation) {
    throw new Error("Failed to copy workflow automation");
  }

  if (
    args.automation.kind === "event" &&
    args.automation.eventType === "webhook-received"
  ) {
    await copyWorkflowWebhookAutomationConfig(tx, {
      orgId: args.orgId,
      userId: args.userId,
      sourceAutomationId: args.automation.id,
      targetAutomationId: copiedAutomation.id,
      currentTime: args.currentTime,
    });
  }
}

async function copyWorkflowUserAutomations(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowAutomationRowsArgs,
): Promise<void> {
  const rows = await tx
    .select()
    .from(zeroWorkflowAutomations)
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, args.userId),
        eq(zeroWorkflowAutomations.workflowId, args.sourceWorkflowId),
      ),
    );
  if (rows.length === 0) {
    return;
  }

  await ensureWorkflowUserAutomationThread(tx, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.targetWorkflowId,
    agentId: args.targetAgentId,
    workflowTitle: args.workflowTitle,
    currentTime: args.currentTime,
  });
  for (const automation of rows) {
    await copyWorkflowAutomationRow(tx, { ...args, automation });
  }
}

async function copyWorkflowRuntimeConfiguration(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowRuntimeArgs,
): Promise<{ readonly id: string } | undefined> {
  const workflow = await insertCopiedWorkflowRow(tx, args);
  if (!workflow) {
    return undefined;
  }

  const scopedRowsArgs = {
    orgId: args.orgId,
    userId: args.userId,
    sourceWorkflowId: args.sourceWorkflow.id,
    targetWorkflowId: workflow.id,
    currentTime: args.currentTime,
  };
  await copyWorkflowUserAutomations(tx, {
    ...scopedRowsArgs,
    targetAgentId: args.targetAgentId,
    workflowTitle: args.sourceWorkflow.displayName ?? args.sourceWorkflow.name,
  });
  return workflow;
}

const copyWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowsDetailContract.copy));
    const bodyResult = await get(copyWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const source = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!source) {
      return workflowNotFound(params.workflowId);
    }

    const targetAgent = await loadAgentForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentId: bodyResult.data.toAgentId,
    });
    signal.throwIfAborted();
    if (!targetAgent) {
      return notFound(`Agent not found: ${bodyResult.data.toAgentId}`);
    }

    const permissionError = requireAgentWritePermission(
      targetAgent,
      member,
      "copy workflows onto this agent",
    );
    if (permissionError) {
      return permissionError;
    }

    const slugError = await requirePrivateWorkflowSlugAvailable(writeDb, {
      orgId: auth.orgId,
      agentId: targetAgent.id,
      ownerUserId: auth.userId,
      name: source.workflow.name,
    });
    signal.throwIfAborted();
    if (slugError) {
      return slugError;
    }

    // A copy is a fork owned by the caller: a new private workflow under the
    // target agent. User-scoped runtime configuration is cloned only for the
    // caller so copies do not leak another user's automations.
    const currentTime = nowDate();
    const inserted = await writeDb.transaction(async (tx) => {
      return await copyWorkflowRuntimeConfiguration(tx, {
        orgId: auth.orgId,
        userId: auth.userId,
        sourceWorkflow: source.workflow,
        targetAgentId: targetAgent.id,
        currentTime,
      });
    });
    signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Failed to copy workflow");
    }

    // Clone the source volume: re-synthesize SKILL.md from the (cloned) DB
    // fields and carry over the supplementary files verbatim.
    const sourceFiles = await loadWorkflowVolumeFiles(get, {
      orgId: auth.orgId,
      workflowId: source.workflow.id,
    });
    signal.throwIfAborted();
    const attachedFiles = (sourceFiles ?? [])
      .filter((file) => {
        return file.path !== "SKILL.md";
      })
      .map((file) => {
        return { path: file.path, content: file.content };
      });
    const skillMd = synthesizeWorkflowSkillMd({
      name: source.workflow.name,
      description: source.workflow.description,
      instruction: source.workflow.instruction,
    });
    await set(
      uploadVolumeServerSide$,
      {
        orgId: auth.orgId,
        storageName: getCustomSkillStorageName(inserted.id),
        files: [{ path: "SKILL.md", content: skillMd }, ...attachedFiles],
      },
      signal,
    );
    signal.throwIfAborted();

    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: inserted.id,
    });
    signal.throwIfAborted();
    if (!visible) {
      throw new Error(`Copied workflow not found: ${inserted.id}`);
    }

    const summary = workflowSummary({
      workflow: visible.workflow,
      agent: visible.agent,
      member,
    });
    return { status: 201 as const, body: summary };
  },
);

function workflowSlashPrompt(workflow: Pick<WorkflowRow, "name">): string {
  return `/${workflow.name}`;
}

function workflowRefinePrompt(workflow: Pick<WorkflowRow, "name">): string {
  return `help me refine the workflow ${workflowSlashPrompt(workflow)}`;
}

const prepareWorkflowChatThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowsDetailContract.chatThread));

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    const { workflow, agent } = visible;

    if (agent.visibility === "private" && agent.owner !== auth.userId) {
      return forbidden("Only the private agent owner can chat with this agent");
    }

    const currentTime = nowDate();
    const chatThreadId = await writeDb.transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId: workflow.id,
        agentId: agent.id,
        workflowTitle: workflow.displayName ?? workflow.name,
        currentTime,
      });
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        chatThreadId,
        prompt: workflowRefinePrompt(workflow),
      },
    };
  },
);

const runWorkflowInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(zeroWorkflowsDetailContract.run));

  const writeDb = set(writeDb$);
  const visible = await loadVisibleWorkflowById(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if (!visible) {
    return workflowNotFound(params.workflowId);
  }
  const { workflow, agent } = visible;

  // The workflow is run on its owning agent; the caller must be able to run
  // that agent (public agents are runnable by any member, private ones only by
  // their owner).
  if (agent.visibility === "private" && agent.owner !== auth.userId) {
    return forbidden("Only the private agent owner can run this agent");
  }

  const currentTime = nowDate();
  const apiStartTime = currentTime.getTime();
  const timing = new ApiDispatchTimingCollector();
  const mappedChatThreadId = await measureApiDispatchTiming(
    timing,
    "api_dispatch_pre_create_zero_workflow_slash_load_thread_mapping",
    "nested",
    async () => {
      return await loadWorkflowUserAutomationThreadId(writeDb, {
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId: workflow.id,
      });
    },
  );
  signal.throwIfAborted();
  const chatThreadId =
    mappedChatThreadId ??
    (await measureApiDispatchTiming(
      timing,
      "api_dispatch_pre_create_zero_workflow_slash_ensure_thread",
      "nested",
      async () => {
        return await writeDb.transaction(async (tx) => {
          return await ensureWorkflowUserAutomationThread(tx, {
            orgId: auth.orgId,
            userId: auth.userId,
            workflowId: workflow.id,
            agentId: agent.id,
            workflowTitle: workflow.displayName ?? workflow.name,
            currentTime,
          });
        });
      },
    ));
  signal.throwIfAborted();

  // Invoking a workflow is exactly typing its slash command in chat.
  const prompt = workflowSlashPrompt(workflow);
  const body = {
    prompt,
    userMessage: createUserMessageDocument({ text: prompt }),
    agentId: agent.id,
    threadId: chatThreadId,
  };
  timing.recordElapsed(
    "api_dispatch_pre_create_zero_workflow_slash_prepare_normal_send",
    "nested",
    apiStartTime,
  );
  const result = await set(
    sendNormalEvent$,
    {
      auth,
      body,
      userId: auth.userId,
      orgId: auth.orgId,
      apiStartTime,
      preloadedAgent: agent,
      timing,
      zeroPreCreateSource: "workflow_slash_command",
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status !== 201) {
    return result;
  }

  return {
    status: 200 as const,
    body: { chatThreadId: result.body.threadId, runId: result.body.runId },
  };
});

interface VisibilityTransition {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
}

async function applyVisibilityUpdate(
  db: Db,
  args: {
    readonly workflowId: string;
    readonly updatedByUserId: string;
    readonly patch: {
      readonly visibility?: "public" | "private";
    };
  },
): Promise<void> {
  await db
    .update(zeroWorkflows)
    .set({
      ...args.patch,
      updatedBy: args.updatedByUserId,
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflows.id, args.workflowId));
}

function summaryFrom(
  args: VisibilityTransition,
  patch: {
    readonly visibility?: "public" | "private";
  },
) {
  const updatedWorkflow: WorkflowRow = {
    ...args.workflow,
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
  };
  return workflowSummary({
    workflow: updatedWorkflow,
    agent: args.agent,
    member: args.member,
  });
}

type NotFoundResponse = ReturnType<typeof notFound>;

async function loadVisibilityTransition(
  db: Db,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
  },
): Promise<VisibilityTransition | NotFoundResponse> {
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: args.workflowId,
  });
  if (!visible) {
    return workflowNotFound(args.workflowId);
  }
  return { ...visible, member: args.member };
}

const publishInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(zeroWorkflowVisibilityContract.publish));

  const writeDb = set(writeDb$);
  const loaded = await loadVisibilityTransition(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if ("status" in loaded) {
    return loaded;
  }
  const { workflow, agent } = loaded;

  if (workflow.ownerUserId !== member.userId) {
    return forbidden("Only the workflow owner can publish this workflow");
  }
  if (workflow.visibility === "public") {
    return { status: 200 as const, body: summaryFrom(loaded, {}) };
  }

  const publishError = requireAgentWritePermission(agent, member, "publish");
  if (publishError) {
    return publishError;
  }

  const slugError = await requirePublicWorkflowSlugAvailable(writeDb, {
    orgId: auth.orgId,
    agentId: workflow.agentId,
    name: workflow.name,
    excludeWorkflowId: workflow.id,
  });
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  await applyVisibilityUpdate(writeDb, {
    workflowId: workflow.id,
    updatedByUserId: auth.userId,
    patch: {
      visibility: "public",
    },
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "public",
    }),
  };
});

const demoteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(zeroWorkflowVisibilityContract.demote));

  const writeDb = set(writeDb$);
  const loaded = await loadVisibilityTransition(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if ("status" in loaded) {
    return loaded;
  }
  const reviewError = requireAgentWritePermission(
    loaded.agent,
    member,
    "demote public workflows",
  );
  if (reviewError) {
    return reviewError;
  }

  const slugError = await requirePrivateWorkflowSlugAvailable(writeDb, {
    orgId: auth.orgId,
    agentId: loaded.workflow.agentId,
    ownerUserId: loaded.workflow.ownerUserId,
    name: loaded.workflow.name,
  });
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  await applyVisibilityUpdate(writeDb, {
    workflowId: loaded.workflow.id,
    updatedByUserId: auth.userId,
    patch: {
      visibility: "private",
    },
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "private",
    }),
  };
});

export const zeroWorkflowsRoutes: readonly RouteEntry[] = [
  {
    route: zeroWorkflowsCollectionContract.list,
    handler: authRoute(workflowReadAuth, listWorkflowsInner$),
  },
  {
    route: zeroWorkflowsCollectionContract.create,
    handler: authRoute(workflowWriteAuth, createWorkflowInner$),
  },
  {
    route: zeroWorkflowsDetailContract.get,
    handler: authRoute(workflowReadAuth, getWorkflowDetailInner$),
  },
  {
    route: zeroWorkflowsDetailContract.update,
    handler: authRoute(workflowWriteAuth, updateWorkflowInner$),
  },
  {
    route: zeroWorkflowsDetailContract.delete,
    handler: authRoute(workflowWriteAuth, deleteWorkflowInner$),
  },
  {
    route: zeroWorkflowsDetailContract.copy,
    handler: authRoute(workflowWriteAuth, copyWorkflowInner$),
  },
  {
    route: zeroWorkflowsDetailContract.chatThread,
    handler: authRoute(workflowReadAuth, prepareWorkflowChatThreadInner$),
  },
  {
    route: zeroWorkflowsDetailContract.run,
    handler: authRoute(workflowWriteAuth, runWorkflowInner$),
  },
  {
    route: zeroWorkflowsDetailContract.connectorReadiness,
    handler: authRoute(workflowReadAuth, connectorReadinessInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.publish,
    handler: authRoute(workflowWriteAuth, publishInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.demote,
    handler: authRoute(workflowWriteAuth, demoteInner$),
  },
];
