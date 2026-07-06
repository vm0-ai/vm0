import { randomBytes } from "node:crypto";

import { command, computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowVisibilityContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@vm0/core/zero-workflow-skill";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflowWebhookTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, ne } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { uploadVolumeServerSide$ } from "../services/storage-volume-upload.service";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { postAutomationUserMessage } from "../services/zero-chat-automation-message.service";
import { createZeroRun$ } from "../services/zero-runs-create.service";
import { deleteZeroWorkflow$ } from "../services/zero-workflow-delete.service";
import { zeroWorkflowDetail } from "../services/zero-workflow-detail.service";
import { ensureWorkflowUserTriggerThread } from "../services/zero-workflow-user-trigger-thread.service";
import { updateZeroWorkflow$ } from "../services/zero-workflow-update.service";
import { loadWorkflowVolumeFiles } from "../services/zero-workflow-volume.service";
import {
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
} from "../services/workflow-webhook-trigger.service";
import { workflowWebhookTriggerCreationEnabledForOwner } from "../services/workflow-webhook-trigger-feature-switch.service";
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

    const permissionError = requireAgentWritePermission(
      agent,
      member,
      "create workflows on this agent",
    );
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

      if (workflow && body.chatThreadId) {
        const chatThreadId = await loadMatchingWorkflowCreationThreadId(tx, {
          userId: auth.userId,
          agentId: agent.id,
          chatThreadId: body.chatThreadId,
        });

        if (chatThreadId) {
          await tx.insert(workflowUserTriggerThreads).values({
            orgId: auth.orgId,
            userId: auth.userId,
            workflowId: workflow.id,
            chatThreadId,
            createdAt: currentTime,
            updatedAt: currentTime,
          });
        }
      }

      return workflow;
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
        storageName: getCustomSkillStorageName(inserted.id),
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
      workflowId: inserted.id,
    });
    signal.throwIfAborted();
    if (!visible) {
      throw new Error(`Created workflow not found: ${inserted.id}`);
    }

    const summary = workflowSummary({
      workflow: visible.workflow,
      agent: visible.agent,
      member,
    });
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
  readonly webhookTriggersEnabled: boolean;
  readonly currentTime: Date;
}

interface CopyWorkflowScopedRowsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceWorkflowId: string;
  readonly targetWorkflowId: string;
  readonly currentTime: Date;
}

interface CopyWorkflowTriggerRowsArgs extends CopyWorkflowScopedRowsArgs {
  readonly targetAgentId: string;
  readonly workflowTitle: string;
  readonly webhookTriggersEnabled: boolean;
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

async function copyWorkflowWebhookTriggerConfig(
  tx: WorkflowCopyTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sourceTriggerId: string;
    readonly targetTriggerId: string;
    readonly currentTime: Date;
  },
): Promise<void> {
  const [sourceWebhook] = await tx
    .select({
      encryptedSecret: zeroWorkflowWebhookTriggers.encryptedSecret,
      secretLastFour: zeroWorkflowWebhookTriggers.secretLastFour,
    })
    .from(zeroWorkflowWebhookTriggers)
    .where(eq(zeroWorkflowWebhookTriggers.triggerId, args.sourceTriggerId))
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

  await tx.insert(zeroWorkflowWebhookTriggers).values({
    triggerId: args.targetTriggerId,
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

async function copyWorkflowTriggerRow(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowScopedRowsArgs & {
    readonly trigger: typeof zeroWorkflowTriggers.$inferSelect;
  },
): Promise<void> {
  const [copiedTrigger] = await tx
    .insert(zeroWorkflowTriggers)
    .values({
      orgId: args.orgId,
      workflowId: args.targetWorkflowId,
      ownerUserId: args.userId,
      kind: args.trigger.kind,
      eventType: args.trigger.eventType,
      eventConfig: args.trigger.eventConfig,
      scheduleType: args.trigger.scheduleType,
      cronExpression: args.trigger.cronExpression,
      intervalSeconds: args.trigger.intervalSeconds,
      atTime: args.trigger.atTime,
      timezone: args.trigger.timezone,
      enabled: args.trigger.enabled,
      nextRunAt: args.trigger.nextRunAt,
      lastRunAt: null,
      lastRunId: null,
      consecutiveFailures: 0,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: zeroWorkflowTriggers.id });
  if (!copiedTrigger) {
    throw new Error("Failed to copy workflow trigger");
  }

  if (
    args.trigger.kind === "event" &&
    args.trigger.eventType === "webhook-received"
  ) {
    await copyWorkflowWebhookTriggerConfig(tx, {
      orgId: args.orgId,
      userId: args.userId,
      sourceTriggerId: args.trigger.id,
      targetTriggerId: copiedTrigger.id,
      currentTime: args.currentTime,
    });
  }
}

async function copyWorkflowUserTriggers(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowTriggerRowsArgs,
): Promise<void> {
  const rows = (
    await tx
      .select()
      .from(zeroWorkflowTriggers)
      .where(
        and(
          eq(zeroWorkflowTriggers.orgId, args.orgId),
          eq(zeroWorkflowTriggers.ownerUserId, args.userId),
          eq(zeroWorkflowTriggers.workflowId, args.sourceWorkflowId),
        ),
      )
  ).filter((trigger) => {
    return (
      args.webhookTriggersEnabled ||
      trigger.kind !== "event" ||
      trigger.eventType !== "webhook-received"
    );
  });
  if (rows.length === 0) {
    return;
  }

  await ensureWorkflowUserTriggerThread(tx, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.targetWorkflowId,
    agentId: args.targetAgentId,
    workflowTitle: args.workflowTitle,
    currentTime: args.currentTime,
  });
  for (const trigger of rows) {
    await copyWorkflowTriggerRow(tx, { ...args, trigger });
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
  await copyWorkflowUserTriggers(tx, {
    ...scopedRowsArgs,
    targetAgentId: args.targetAgentId,
    workflowTitle: args.sourceWorkflow.displayName ?? args.sourceWorkflow.name,
    webhookTriggersEnabled: args.webhookTriggersEnabled,
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
    const webhookTriggersEnabled = await get(
      workflowWebhookTriggerCreationEnabledForOwner(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
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
    // caller so copies do not leak another user's triggers.
    const currentTime = nowDate();
    const inserted = await writeDb.transaction(async (tx) => {
      return await copyWorkflowRuntimeConfiguration(tx, {
        orgId: auth.orgId,
        userId: auth.userId,
        sourceWorkflow: source.workflow,
        targetAgentId: targetAgent.id,
        webhookTriggersEnabled,
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

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

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
      return await ensureWorkflowUserTriggerThread(tx, {
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

  const now = nowDate();
  const chatThreadId = await writeDb.transaction(async (tx) => {
    return await ensureWorkflowUserTriggerThread(tx, {
      orgId: auth.orgId,
      userId: auth.userId,
      workflowId: workflow.id,
      agentId: agent.id,
      workflowTitle: workflow.displayName ?? workflow.name,
      currentTime: now,
    });
  });
  signal.throwIfAborted();

  // Invoking a workflow is exactly typing its slash command in chat.
  const prompt = workflowSlashPrompt(workflow);
  const result = await set(
    createZeroRun$,
    {
      auth: {
        orgId: auth.orgId,
        orgRole: auth.orgRole ?? "member",
        userId: auth.userId,
        tokenType: "session",
      },
      body: { prompt, agentId: agent.id },
      apiStartTime: now.getTime(),
      triggerSource: "web",
      zeroPreCreateSource: "workflow_slash_command",
      chatThreadId,
      callbacks: [
        {
          internalKind: "chat",
          secret: generateCallbackSecret(),
          payload: { threadId: chatThreadId, agentId: agent.id },
        },
      ],
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status !== 201) {
    return result;
  }

  await postAutomationUserMessage({
    db: writeDb,
    threadId: chatThreadId,
    userId: auth.userId,
    runId: result.body.runId,
    prompt,
    appendQueueMarker: result.body.status === "queued",
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { chatThreadId, runId: result.body.runId },
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
    route: zeroWorkflowVisibilityContract.publish,
    handler: authRoute(workflowWriteAuth, publishInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.demote,
    handler: authRoute(workflowWriteAuth, demoteInner$),
  },
];
