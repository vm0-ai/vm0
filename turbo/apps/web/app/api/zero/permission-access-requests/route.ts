import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  permissionAccessRequestsCreateContract,
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
  isFirewallConnectorType,
  type FirewallPolicies,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { permissionAccessRequests } from "../../../../src/db/schema/permission-access-request";
import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAgentPermission } from "../../../../src/lib/zero/require-agent-permission";
import {
  notifyOwnerOfRequest,
  notifyRequesterOfResolution,
} from "../../../../src/lib/zero/permission-notification-service";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero:permission-access-requests");

function formatRequest(
  row: typeof permissionAccessRequests.$inferSelect,
  nameMap?: Map<string, string>,
) {
  return {
    id: row.id,
    agentId: row.agentId,
    connectorRef: row.connectorRef,
    permission: row.permission,
    action: row.action,
    method: row.method ?? null,
    path: row.path ?? null,
    reason: row.reason ?? null,
    status: row.status as "pending" | "approved" | "rejected",
    requesterUserId: row.requesterUserId,
    requesterName: nameMap?.get(row.requesterUserId) ?? null,
    resolvedBy: row.resolvedBy ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function resolveUserNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const unique = [...new Set(userIds)];
  const client = await clerkClient();
  const users = await client.users.getUserList({
    userId: unique,
    limit: unique.length,
  });
  for (const u of users.data) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    if (name) {
      map.set(u.id, name);
    }
  }
  return map;
}

// --- POST: Create Request ---
const createRouter = tsr.router(permissionAccessRequestsCreateContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Validate connector ref
    if (!isFirewallConnectorType(body.connectorRef)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Unknown connector ref: ${body.connectorRef}`,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    // Verify agent belongs to org
    const [agent] = await globalThis.services.db
      .select({
        id: zeroAgents.id,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
      })
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, body.agentId)),
      )
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${body.agentId}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // One request per (agent, ref, permission, action, requester) — reuse existing
    const [existing] = await globalThis.services.db
      .select()
      .from(permissionAccessRequests)
      .where(
        and(
          eq(permissionAccessRequests.agentId, body.agentId),
          eq(permissionAccessRequests.connectorRef, body.connectorRef),
          eq(permissionAccessRequests.permission, body.permission),
          eq(permissionAccessRequests.action, body.action),
          eq(permissionAccessRequests.requesterUserId, member.userId),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await globalThis.services.db
        .update(permissionAccessRequests)
        .set({
          reason: body.reason ?? existing.reason,
          method: body.method ?? existing.method,
          path: body.path ?? existing.path,
          status: "pending",
          resolvedBy: null,
          resolvedAt: null,
        })
        .where(eq(permissionAccessRequests.id, existing.id))
        .returning();

      log.info(
        `Reused permission access request: ${existing.id} (was ${existing.status}) for agent: ${body.agentId}`,
      );

      const requesterNames = await resolveUserNames([member.userId]);
      notifyOwnerOfRequest({
        orgId: org.orgId,
        ownerUserId: agent.owner,
        agentId: body.agentId,
        requestId: existing.id,
        agentDisplayName: agent.displayName ?? body.agentId,
        requesterName: requesterNames.get(member.userId) ?? member.userId,
        permission: body.permission,
        connectorRef: body.connectorRef,
        action: body.action,
        reason: body.reason,
      }).catch(() => {});

      return {
        status: 201 as const,
        body: formatRequest(updated!),
      };
    }

    // Create new request (first time for this combination)
    const [created] = await globalThis.services.db
      .insert(permissionAccessRequests)
      .values({
        orgId: org.orgId,
        agentId: body.agentId,
        requesterUserId: member.userId,
        connectorRef: body.connectorRef,
        permission: body.permission,
        action: body.action,
        method: body.method,
        path: body.path,
        reason: body.reason,
      })
      .returning();

    log.info(
      `Created permission access request: ${created!.id} for agent: ${body.agentId}`,
    );

    const requesterNames = await resolveUserNames([member.userId]);
    notifyOwnerOfRequest({
      orgId: org.orgId,
      ownerUserId: agent.owner,
      agentId: body.agentId,
      requestId: created!.id,
      agentDisplayName: agent.displayName ?? body.agentId,
      requesterName: requesterNames.get(member.userId) ?? member.userId,
      permission: body.permission,
      connectorRef: body.connectorRef,
      action: body.action,
      reason: body.reason,
    }).catch(() => {});

    return {
      status: 201 as const,
      body: formatRequest(created!),
    };
  },
});

// --- GET: List Requests ---
const listRouter = tsr.router(permissionAccessRequestsListContract, {
  list: async ({ headers, query }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    const { agentId, requestId, status } = query;

    if (!agentId && !requestId) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Either agentId or requestId is required",
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    // Fetch by requestId — return single-element array
    if (requestId) {
      const [row] = await globalThis.services.db
        .select()
        .from(permissionAccessRequests)
        .where(
          and(
            eq(permissionAccessRequests.id, requestId),
            eq(permissionAccessRequests.orgId, org.orgId),
          ),
        )
        .limit(1);

      if (!row) {
        return { status: 200 as const, body: [] };
      }

      const nameMap = await resolveUserNames([row.requesterUserId]);
      return {
        status: 200 as const,
        body: [formatRequest(row, nameMap)],
      };
    }

    // Look up agent owner
    const [agent] = await globalThis.services.db
      .select({ owner: zeroAgents.owner })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, agentId!)))
      .limit(1);

    const isOwnerOrAdmin =
      agent?.owner === member.userId || member.role === "admin";

    // Build conditions
    const conditions = [
      eq(permissionAccessRequests.agentId, agentId!),
      eq(permissionAccessRequests.orgId, org.orgId),
    ];

    // Agent owner and org admin see all requests, others see only own
    if (!isOwnerOrAdmin) {
      conditions.push(
        eq(permissionAccessRequests.requesterUserId, member.userId),
      );
    }

    if (status) {
      conditions.push(eq(permissionAccessRequests.status, status));
    }

    const rows = await globalThis.services.db
      .select()
      .from(permissionAccessRequests)
      .where(and(...conditions));

    const nameMap = await resolveUserNames(
      rows.map((r) => {
        return r.requesterUserId;
      }),
    );

    return {
      status: 200 as const,
      body: rows.map((r) => {
        return formatRequest(r, nameMap);
      }),
    };
  },
});

// --- PUT: Resolve Request ---
const resolveRouter = tsr.router(permissionAccessRequestsResolveContract, {
  resolve: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Find the request and agent info in a single query
    const [row] = await globalThis.services.db
      .select({
        request: permissionAccessRequests,
        agentOwner: zeroAgents.owner,
        agentDisplayName: zeroAgents.displayName,
      })
      .from(permissionAccessRequests)
      .innerJoin(
        zeroAgents,
        eq(permissionAccessRequests.agentId, zeroAgents.id),
      )
      .where(
        and(
          eq(permissionAccessRequests.id, body.requestId),
          eq(permissionAccessRequests.orgId, org.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Access request not found: ${body.requestId}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    const existing = row.request;

    // Only agent owner or org admin can resolve requests
    const forbidden = requireAgentPermission(
      row.agentOwner,
      member,
      "resolve permission access requests",
    );
    if (forbidden) return forbidden;

    if (existing.status !== "pending") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Request already resolved with status: ${existing.status}`,
            code: "ALREADY_RESOLVED",
          },
        },
      };
    }

    const now = new Date();
    const newStatus = body.action === "approve" ? "approved" : "rejected";

    const db = globalThis.services.db;

    const [updated] = await db.transaction(async (tx) => {
      // On approve: also update the agent's permissionPolicies
      if (body.action === "approve") {
        const [agent] = await tx
          .select({ permissionPolicies: zeroAgents.permissionPolicies })
          .from(zeroAgents)
          .where(eq(zeroAgents.id, existing.agentId))
          .limit(1);

        const currentPolicies =
          (agent?.permissionPolicies as FirewallPolicies | null) ?? {};
        const refPolicies = currentPolicies[existing.connectorRef] ?? {};
        const updatedPolicies: FirewallPolicies = {
          ...currentPolicies,
          [existing.connectorRef]: {
            ...refPolicies,
            [existing.permission]: existing.action,
          },
        };

        await tx
          .update(zeroAgents)
          .set({ permissionPolicies: updatedPolicies, updatedAt: now })
          .where(eq(zeroAgents.id, existing.agentId));
      }

      // Update request status
      return tx
        .update(permissionAccessRequests)
        .set({
          status: newStatus,
          resolvedBy: member.userId,
          resolvedAt: now,
        })
        .where(eq(permissionAccessRequests.id, body.requestId))
        .returning();
    });

    log.info(
      `Resolved permission access request: ${body.requestId} as ${newStatus}`,
    );

    notifyRequesterOfResolution({
      orgId: org.orgId,
      requestId: body.requestId,
      agentId: existing.agentId,
      agentDisplayName: row.agentDisplayName ?? existing.agentId,
      requesterUserId: existing.requesterUserId,
      permission: existing.permission,
      connectorRef: existing.connectorRef,
      action: existing.action,
      resolution: body.action,
    }).catch(() => {});

    return {
      status: 200 as const,
      body: formatRequest(updated!),
    };
  },
});

const postHandler = createHandler(
  permissionAccessRequestsCreateContract,
  createRouter,
  { errorHandler: createSafeErrorHandler("zero:permission-access-requests") },
);

const getHandler = createHandler(
  permissionAccessRequestsListContract,
  listRouter,
  { errorHandler: createSafeErrorHandler("zero:permission-access-requests") },
);

const putHandler = createHandler(
  permissionAccessRequestsResolveContract,
  resolveRouter,
  { errorHandler: createSafeErrorHandler("zero:permission-access-requests") },
);

export { postHandler as POST, getHandler as GET, putHandler as PUT };
