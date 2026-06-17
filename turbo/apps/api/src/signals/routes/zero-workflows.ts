import { command, computed } from "ccstate";
import {
  zeroWorkflowAgentsContract,
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  zeroWorkflowAgents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, inArray } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { uploadVolumeServerSide$ } from "../services/storage-volume-upload.service";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { deleteZeroWorkflow$ } from "../services/zero-workflow-delete.service";
import { zeroWorkflowDetail } from "../services/zero-workflow-detail.service";
import { updateZeroWorkflow$ } from "../services/zero-workflow-update.service";
import {
  loadVisibleWorkflow,
  loadWorkflowByName,
  requireWorkflowPermission,
  workflowSummary,
  zeroWorkflowList,
  type WorkflowMember,
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

function workflowNotFound(name: string) {
  return notFound(`Workflow not found: ${name}`);
}

function publicWorkflowAdminRequired(action: string, member: WorkflowMember) {
  return member.role === "admin"
    ? null
    : forbidden(`Only org admins can ${action}`);
}

async function loadAgentForConfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
) {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
    )
    .limit(1);

  return agent ?? null;
}

async function loadAgentsForConfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentIds: readonly string[];
  },
) {
  if (args.agentIds.length === 0) {
    return [];
  }

  return await db
    .select({
      id: zeroAgents.id,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        inArray(zeroAgents.id, [...args.agentIds]),
      ),
    );
}

function requireAgentConfigurationPermission(
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
  action: string,
) {
  return requireAgentPermission(agent.owner, member, action, {
    visibility: agent.visibility,
  });
}

function requireWorkflowAttachmentPermission(
  workflow: { readonly visibility: "public" | "private" },
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
  action: string,
) {
  if (workflow.visibility === "private" && agent.visibility === "public") {
    return null;
  }

  return requireAgentConfigurationPermission(agent, member, action);
}

async function currentAttachmentAgentIds(
  db: Db,
  args: {
    readonly orgId: string;
    readonly workflowId: string;
  },
): Promise<readonly string[]> {
  const rows = await db
    .select({ agentId: zeroWorkflowAgents.agentId })
    .from(zeroWorkflowAgents)
    .where(
      and(
        eq(zeroWorkflowAgents.orgId, args.orgId),
        eq(zeroWorkflowAgents.workflowId, args.workflowId),
      ),
    );

  return rows.map((row) => {
    return row.agentId;
  });
}

const createWorkflowBody$ = bodyResultOf(
  zeroWorkflowsCollectionContract.create,
);
const updateWorkflowBody$ = bodyResultOf(zeroWorkflowsDetailContract.update);
const attachWorkflowAgentBody$ = bodyResultOf(
  zeroWorkflowAgentsContract.attach,
);
const setWorkflowAgentsBody$ = bodyResultOf(zeroWorkflowAgentsContract.set);

const listWorkflowsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const workflows = await get(
    zeroWorkflowList({
      orgId: auth.orgId,
      member: memberFromAuth(auth),
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
    if (visibility === "public") {
      const adminRequired = publicWorkflowAdminRequired(
        "create public workflows",
        member,
      );
      if (adminRequired) {
        return adminRequired;
      }
    }

    if (SEED_SKILLS.includes(body.name)) {
      return conflict(
        `Workflow name "${body.name}" conflicts with a built-in workflow`,
      );
    }

    const writeDb = set(writeDb$);
    const existingWorkflow = await loadWorkflowByName(writeDb, {
      orgId: auth.orgId,
      name: body.name,
    });
    signal.throwIfAborted();

    if (existingWorkflow) {
      return conflict(
        `Workflow "${body.name}" already exists in this organization`,
      );
    }

    await writeDb.insert(zeroWorkflows).values({
      orgId: auth.orgId,
      name: body.name,
      visibility,
      ownerUserId: auth.userId,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      createdBy: auth.userId,
    });
    signal.throwIfAborted();

    await set(
      uploadVolumeServerSide$,
      {
        orgId: auth.orgId,
        storageName: getCustomSkillStorageName(body.name),
        files: body.files,
      },
      signal,
    );
    signal.throwIfAborted();

    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: body.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      throw new Error(`Created workflow not found: ${body.name}`);
    }

    const summary = await workflowSummary(writeDb, { workflow, member });
    signal.throwIfAborted();
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
      workflowName: params.name,
    }),
  );
  if (!result) {
    return workflowNotFound(params.name);
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
    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      return workflowNotFound(params.name);
    }

    const permissionError = requireWorkflowPermission(
      workflow,
      member,
      "update workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    if (bodyResult.data.visibility === "public") {
      const adminRequired = publicWorkflowAdminRequired(
        "make workflows public",
        member,
      );
      if (adminRequired) {
        return adminRequired;
      }
    }

    const content = await set(
      updateZeroWorkflow$,
      { workflow, body: bodyResult.data },
      signal,
    );
    signal.throwIfAborted();

    const updatedWorkflow = await loadWorkflowByName(writeDb, {
      orgId: auth.orgId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!updatedWorkflow) {
      return workflowNotFound(params.name);
    }

    const summary = await workflowSummary(writeDb, {
      workflow: updatedWorkflow,
      member,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ...summary, ...content },
    };
  },
);

const deleteWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowsDetailContract.delete));

    const writeDb = set(writeDb$);
    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      return workflowNotFound(params.name);
    }

    const permissionError = requireWorkflowPermission(
      workflow,
      member,
      "delete workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    const deleted = await set(
      deleteZeroWorkflow$,
      { orgId: auth.orgId, workflowName: params.name },
      signal,
    );
    signal.throwIfAborted();

    if (!deleted) {
      return workflowNotFound(params.name);
    }

    return { status: 204 as const, body: undefined };
  },
);

const listWorkflowAgentsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(zeroWorkflowAgentsContract.list));
  const db = get(db$);
  const workflow = await loadVisibleWorkflow(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    name: params.name,
  });
  if (!workflow) {
    return workflowNotFound(params.name);
  }

  const summary = await workflowSummary(db, { workflow, member });
  return { status: 200 as const, body: summary.attachedAgents };
});

const attachWorkflowAgentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowAgentsContract.attach));
    const bodyResult = await get(attachWorkflowAgentBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      return workflowNotFound(params.name);
    }

    const workflowPermissionError = requireWorkflowPermission(
      workflow,
      member,
      "attach workflow to agents",
    );
    if (workflowPermissionError) {
      return workflowPermissionError;
    }

    const agent = await loadAgentForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentId: bodyResult.data.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return notFound(`Agent not found: ${bodyResult.data.agentId}`);
    }

    const agentPermissionError = requireWorkflowAttachmentPermission(
      workflow,
      agent,
      member,
      "attach workflow to this agent",
    );
    if (agentPermissionError) {
      return agentPermissionError;
    }

    await writeDb
      .insert(zeroWorkflowAgents)
      .values({
        orgId: auth.orgId,
        workflowId: workflow.id,
        agentId: agent.id,
        createdBy: auth.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    const summary = await workflowSummary(writeDb, { workflow, member });
    signal.throwIfAborted();
    return { status: 200 as const, body: summary };
  },
);

const setWorkflowAgentsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowAgentsContract.set));
    const bodyResult = await get(setWorkflowAgentsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      return workflowNotFound(params.name);
    }

    const workflowPermissionError = requireWorkflowPermission(
      workflow,
      member,
      "update workflow agent attachments",
    );
    if (workflowPermissionError) {
      return workflowPermissionError;
    }

    const requestedAgentIds = [...new Set(bodyResult.data.agentIds)];
    const existingAgentIds = await currentAttachmentAgentIds(writeDb, {
      orgId: auth.orgId,
      workflowId: workflow.id,
    });
    signal.throwIfAborted();
    const permissionAgentIds = [
      ...new Set([...existingAgentIds, ...requestedAgentIds]),
    ];
    const agents = await loadAgentsForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentIds: permissionAgentIds,
    });
    signal.throwIfAborted();

    const agentById = new Map(
      agents.map((agent) => {
        return [agent.id, agent];
      }),
    );
    for (const agentId of permissionAgentIds) {
      const agent = agentById.get(agentId);
      if (!agent) {
        return notFound(`Agent not found: ${agentId}`);
      }

      const agentPermissionError = requireWorkflowAttachmentPermission(
        workflow,
        agent,
        member,
        "update workflow attachments on this agent",
      );
      if (agentPermissionError) {
        return agentPermissionError;
      }
    }

    await writeDb.transaction(async (tx) => {
      await tx
        .delete(zeroWorkflowAgents)
        .where(
          and(
            eq(zeroWorkflowAgents.orgId, auth.orgId),
            eq(zeroWorkflowAgents.workflowId, workflow.id),
          ),
        );

      if (requestedAgentIds.length > 0) {
        await tx.insert(zeroWorkflowAgents).values(
          requestedAgentIds.map((agentId) => {
            return {
              orgId: auth.orgId,
              workflowId: workflow.id,
              agentId,
              createdBy: auth.userId,
            };
          }),
        );
      }
    });
    signal.throwIfAborted();

    const summary = await workflowSummary(writeDb, { workflow, member });
    signal.throwIfAborted();
    return { status: 200 as const, body: summary };
  },
);

const detachWorkflowAgentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(zeroWorkflowAgentsContract.detach));

    const writeDb = set(writeDb$);
    const workflow = await loadVisibleWorkflow(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
      name: params.name,
    });
    signal.throwIfAborted();
    if (!workflow) {
      return workflowNotFound(params.name);
    }

    const workflowPermissionError = requireWorkflowPermission(
      workflow,
      member,
      "detach workflow from agents",
    );
    if (workflowPermissionError) {
      return workflowPermissionError;
    }

    const agent = await loadAgentForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentId: params.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return notFound(`Agent not found: ${params.agentId}`);
    }

    const agentPermissionError = requireWorkflowAttachmentPermission(
      workflow,
      agent,
      member,
      "detach workflow from this agent",
    );
    if (agentPermissionError) {
      return agentPermissionError;
    }

    await writeDb
      .delete(zeroWorkflowAgents)
      .where(
        and(
          eq(zeroWorkflowAgents.orgId, auth.orgId),
          eq(zeroWorkflowAgents.workflowId, workflow.id),
          eq(zeroWorkflowAgents.agentId, params.agentId),
        ),
      );
    signal.throwIfAborted();

    const summary = await workflowSummary(writeDb, { workflow, member });
    signal.throwIfAborted();
    return { status: 200 as const, body: summary };
  },
);

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
    route: zeroWorkflowAgentsContract.list,
    handler: authRoute(workflowReadAuth, listWorkflowAgentsInner$),
  },
  {
    route: zeroWorkflowAgentsContract.attach,
    handler: authRoute(workflowWriteAuth, attachWorkflowAgentInner$),
  },
  {
    route: zeroWorkflowAgentsContract.set,
    handler: authRoute(workflowWriteAuth, setWorkflowAgentsInner$),
  },
  {
    route: zeroWorkflowAgentsContract.detach,
    handler: authRoute(workflowWriteAuth, detachWorkflowAgentInner$),
  },
];
