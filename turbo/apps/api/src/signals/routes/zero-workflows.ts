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
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { and, eq } from "drizzle-orm";

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
import { updateZeroWorkflow$ } from "../services/zero-workflow-update.service";
import { loadWorkflowVolumeFiles } from "../services/zero-workflow-volume.service";
import {
  loadVisibleWorkflowById,
  requireWorkflowPermission,
  workflowSummary,
  zeroWorkflowList,
  type WorkflowAgentInfo,
  type WorkflowMember,
  type WorkflowRow,
} from "../services/zero-workflow-data.service";
import type { RouteEntry } from "../route";

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

    const [inserted] = await writeDb
      .insert(zeroWorkflows)
      .values({
        orgId: auth.orgId,
        agentId: agent.id,
        name: body.name,
        visibility,
        type: "workflow",
        instruction: body.instruction ?? null,
        ownerUserId: auth.userId,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        createdBy: auth.userId,
      })
      .returning({ id: zeroWorkflows.id });
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

    await set(
      updateZeroWorkflow$,
      { workflow: visible.workflow, body: bodyResult.data },
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

    // A copy is a fork owned by the caller: a new private workflow under the
    // target agent, carrying the source instruction/metadata and volume files.
    const [inserted] = await writeDb
      .insert(zeroWorkflows)
      .values({
        orgId: auth.orgId,
        agentId: targetAgent.id,
        name: source.workflow.name,
        visibility: "private",
        type: "workflow",
        instruction: source.workflow.instruction,
        ownerUserId: auth.userId,
        displayName: source.workflow.displayName,
        description: source.workflow.description,
        createdBy: auth.userId,
      })
      .returning({ id: zeroWorkflows.id });
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
    const attachedFiles = sourceFiles
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
  const [thread] = await writeDb
    .insert(chatThreads)
    .values({
      userId: auth.userId,
      agentComposeId: agent.id,
      title: workflow.displayName ?? workflow.name,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Failed to create workflow run chat thread");
  }

  // Invoking a workflow is exactly typing its slash command in chat.
  const prompt = `/${workflow.name}`;
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
      chatThreadId: thread.id,
      callbacks: [
        {
          internalKind: "chat",
          secret: generateCallbackSecret(),
          payload: { threadId: thread.id, agentId: agent.id },
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
    threadId: thread.id,
    userId: auth.userId,
    runId: result.body.runId,
    prompt,
    appendQueueMarker: result.body.status === "queued",
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { chatThreadId: thread.id, runId: result.body.runId },
  };
});

interface VisibilityTransition {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
}

async function applyVisibilityUpdate(
  db: Db,
  workflowId: string,
  patch: {
    readonly visibility?: "public" | "private";
    readonly requestToPublish?: boolean;
  },
): Promise<void> {
  await db
    .update(zeroWorkflows)
    .set({ ...patch, updatedAt: nowDate() })
    .where(eq(zeroWorkflows.id, workflowId));
}

function summaryFrom(
  args: VisibilityTransition,
  patch: {
    readonly visibility?: "public" | "private";
    readonly requestToPublish?: boolean;
  },
) {
  const updatedWorkflow: WorkflowRow = {
    ...args.workflow,
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    ...(patch.requestToPublish !== undefined
      ? { requestToPublish: patch.requestToPublish }
      : {}),
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

const requestPublishInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(
      pathParamsOf(zeroWorkflowVisibilityContract.requestPublish),
    );

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
      return forbidden("Only the workflow owner can request to publish");
    }
    if (workflow.visibility === "public") {
      return { status: 200 as const, body: summaryFrom(loaded, {}) };
    }

    // An owner who can write the host agent publishes directly; otherwise the
    // request is queued for a reviewer.
    const canPublishDirectly =
      requireAgentWritePermission(agent, member, "publish") === null;
    if (canPublishDirectly) {
      await applyVisibilityUpdate(writeDb, workflow.id, {
        visibility: "public",
        requestToPublish: false,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: summaryFrom(loaded, {
          visibility: "public",
          requestToPublish: false,
        }),
      };
    }

    await applyVisibilityUpdate(writeDb, workflow.id, {
      requestToPublish: true,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: summaryFrom(loaded, { requestToPublish: true }),
    };
  },
);

const cancelPublishRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(
      pathParamsOf(zeroWorkflowVisibilityContract.cancelPublishRequest),
    );

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
    if (loaded.workflow.ownerUserId !== member.userId) {
      return forbidden("Only the workflow owner can cancel a publish request");
    }

    await applyVisibilityUpdate(writeDb, loaded.workflow.id, {
      requestToPublish: false,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: summaryFrom(loaded, { requestToPublish: false }),
    };
  },
);

const approvePublishInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(
      pathParamsOf(zeroWorkflowVisibilityContract.approvePublish),
    );

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
      "approve publish requests",
    );
    if (reviewError) {
      return reviewError;
    }

    await applyVisibilityUpdate(writeDb, loaded.workflow.id, {
      visibility: "public",
      requestToPublish: false,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: summaryFrom(loaded, {
        visibility: "public",
        requestToPublish: false,
      }),
    };
  },
);

const rejectPublishInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(
      pathParamsOf(zeroWorkflowVisibilityContract.rejectPublish),
    );

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
      "reject publish requests",
    );
    if (reviewError) {
      return reviewError;
    }

    await applyVisibilityUpdate(writeDb, loaded.workflow.id, {
      requestToPublish: false,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: summaryFrom(loaded, { requestToPublish: false }),
    };
  },
);

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

  await applyVisibilityUpdate(writeDb, loaded.workflow.id, {
    visibility: "private",
    requestToPublish: false,
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "private",
      requestToPublish: false,
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
    route: zeroWorkflowsDetailContract.run,
    handler: authRoute(workflowWriteAuth, runWorkflowInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.requestPublish,
    handler: authRoute(workflowWriteAuth, requestPublishInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.cancelPublishRequest,
    handler: authRoute(workflowWriteAuth, cancelPublishRequestInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.approvePublish,
    handler: authRoute(workflowWriteAuth, approvePublishInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.rejectPublish,
    handler: authRoute(workflowWriteAuth, rejectPublishInner$),
  },
  {
    route: zeroWorkflowVisibilityContract.demote,
    handler: authRoute(workflowWriteAuth, demoteInner$),
  },
];
