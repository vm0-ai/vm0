import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  firewallAccessRequestsCreateContract,
  firewallAccessRequestsListContract,
  firewallAccessRequestsResolveContract,
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
import { firewallAccessRequests } from "../../../../src/db/schema/firewall-access-request";
import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAgentPermission } from "../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero:firewall-access-requests");

function formatRequest(
  row: typeof firewallAccessRequests.$inferSelect,
  nameMap?: Map<string, string>,
) {
  return {
    id: row.id,
    agentId: row.agentId,
    firewallRef: row.firewallRef,
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
const createRouter = tsr.router(firewallAccessRequestsCreateContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Validate firewall ref
    if (!isFirewallConnectorType(body.firewallRef)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Unknown firewall ref: ${body.firewallRef}`,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    // Verify agent belongs to org
    const [agent] = await globalThis.services.db
      .select({ id: zeroAgents.id })
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
      .from(firewallAccessRequests)
      .where(
        and(
          eq(firewallAccessRequests.agentId, body.agentId),
          eq(firewallAccessRequests.firewallRef, body.firewallRef),
          eq(firewallAccessRequests.permission, body.permission),
          eq(firewallAccessRequests.action, body.action),
          eq(firewallAccessRequests.requesterUserId, member.userId),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await globalThis.services.db
        .update(firewallAccessRequests)
        .set({
          reason: body.reason ?? existing.reason,
          method: body.method ?? existing.method,
          path: body.path ?? existing.path,
          status: "pending",
          resolvedBy: null,
          resolvedAt: null,
        })
        .where(eq(firewallAccessRequests.id, existing.id))
        .returning();

      log.info(
        `Reused firewall access request: ${existing.id} (was ${existing.status}) for agent: ${body.agentId}`,
      );

      return {
        status: 201 as const,
        body: formatRequest(updated!),
      };
    }

    // Create new request (first time for this combination)
    const [created] = await globalThis.services.db
      .insert(firewallAccessRequests)
      .values({
        orgId: org.orgId,
        agentId: body.agentId,
        requesterUserId: member.userId,
        firewallRef: body.firewallRef,
        permission: body.permission,
        action: body.action,
        method: body.method,
        path: body.path,
        reason: body.reason,
      })
      .returning();

    log.info(
      `Created firewall access request: ${created!.id} for agent: ${body.agentId}`,
    );

    return {
      status: 201 as const,
      body: formatRequest(created!),
    };
  },
});

// --- GET: List Requests ---
const listRouter = tsr.router(firewallAccessRequestsListContract, {
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
        .from(firewallAccessRequests)
        .where(
          and(
            eq(firewallAccessRequests.id, requestId),
            eq(firewallAccessRequests.orgId, org.orgId),
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
      eq(firewallAccessRequests.agentId, agentId!),
      eq(firewallAccessRequests.orgId, org.orgId),
    ];

    // Agent owner and org admin see all requests, others see only own
    if (!isOwnerOrAdmin) {
      conditions.push(
        eq(firewallAccessRequests.requesterUserId, member.userId),
      );
    }

    if (status) {
      conditions.push(eq(firewallAccessRequests.status, status));
    }

    const rows = await globalThis.services.db
      .select()
      .from(firewallAccessRequests)
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
const resolveRouter = tsr.router(firewallAccessRequestsResolveContract, {
  resolve: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Find the request and agent owner in a single query
    const [row] = await globalThis.services.db
      .select({
        request: firewallAccessRequests,
        agentOwner: zeroAgents.owner,
      })
      .from(firewallAccessRequests)
      .innerJoin(zeroAgents, eq(firewallAccessRequests.agentId, zeroAgents.id))
      .where(
        and(
          eq(firewallAccessRequests.id, body.requestId),
          eq(firewallAccessRequests.orgId, org.orgId),
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
      "resolve firewall access requests",
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
      // On approve: also update the agent's firewallPolicies
      if (body.action === "approve") {
        const [agent] = await tx
          .select({ firewallPolicies: zeroAgents.firewallPolicies })
          .from(zeroAgents)
          .where(eq(zeroAgents.id, existing.agentId))
          .limit(1);

        const currentPolicies =
          (agent?.firewallPolicies as FirewallPolicies | null) ?? {};
        const refPolicies = currentPolicies[existing.firewallRef] ?? {};
        const updatedPolicies: FirewallPolicies = {
          ...currentPolicies,
          [existing.firewallRef]: {
            ...refPolicies,
            [existing.permission]: existing.action,
          },
        };

        await tx
          .update(zeroAgents)
          .set({ firewallPolicies: updatedPolicies, updatedAt: now })
          .where(eq(zeroAgents.id, existing.agentId));
      }

      // Update request status
      return tx
        .update(firewallAccessRequests)
        .set({
          status: newStatus,
          resolvedBy: member.userId,
          resolvedAt: now,
        })
        .where(eq(firewallAccessRequests.id, body.requestId))
        .returning();
    });

    log.info(
      `Resolved firewall access request: ${body.requestId} as ${newStatus}`,
    );

    return {
      status: 200 as const,
      body: formatRequest(updated!),
    };
  },
});

const postHandler = createHandler(
  firewallAccessRequestsCreateContract,
  createRouter,
  { errorHandler: createSafeErrorHandler("zero:firewall-access-requests") },
);

const getHandler = createHandler(
  firewallAccessRequestsListContract,
  listRouter,
  { errorHandler: createSafeErrorHandler("zero:firewall-access-requests") },
);

const putHandler = createHandler(
  firewallAccessRequestsResolveContract,
  resolveRouter,
  { errorHandler: createSafeErrorHandler("zero:firewall-access-requests") },
);

export { postHandler as POST, getHandler as GET, putHandler as PUT };
