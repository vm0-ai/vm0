import { computed, type Computed } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import type { PermissionAccessRequestResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { permissionAccessRequests } from "@vm0/db/schema/permission-access-request";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import type { ApiOrgRole } from "../../types/auth";

type PermissionAccessRequestRow = typeof permissionAccessRequests.$inferSelect;

interface ListPermissionAccessRequestsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole: ApiOrgRole | undefined;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly status?: string;
}

function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

function permissionAccessRequestStatus(
  status: string,
): PermissionAccessRequestResponse["status"] {
  if (status === "pending" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new Error(`Unexpected permission access request status: ${status}`);
}

function formatPermissionAccessRequest(
  row: PermissionAccessRequestRow,
  nameMap: ReadonlyMap<string, string>,
): PermissionAccessRequestResponse {
  return {
    id: row.id,
    agentId: row.agentId,
    connectorRef: row.connectorRef,
    permission: row.permission,
    action: row.action,
    method: row.method ?? null,
    path: row.path ?? null,
    reason: row.reason ?? null,
    status: permissionAccessRequestStatus(row.status),
    requesterUserId: row.requesterUserId,
    requesterName: nameMap.get(row.requesterUserId) ?? null,
    resolvedBy: row.resolvedBy ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requesterNameMap(
  client: ReturnType<typeof clerk$.read>,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(userIds)];
  const map = new Map<string, string>();
  if (uniqueUserIds.length === 0) {
    return map;
  }

  const users = await client.users.getUserList({
    userId: uniqueUserIds,
    limit: uniqueUserIds.length,
  });
  for (const user of users.data) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    if (name) {
      map.set(user.id, name);
    }
  }
  return map;
}

export function listPermissionAccessRequests(
  args: ListPermissionAccessRequestsArgs,
): Computed<Promise<readonly PermissionAccessRequestResponse[]>> {
  return computed(
    async (get): Promise<readonly PermissionAccessRequestResponse[]> => {
      const db = get(db$);
      const client = get(clerk$);

      if (args.requestId) {
        const [row] = await db
          .select({ request: permissionAccessRequests })
          .from(permissionAccessRequests)
          .innerJoin(
            zeroAgents,
            eq(permissionAccessRequests.agentId, zeroAgents.id),
          )
          .where(
            and(
              eq(permissionAccessRequests.id, args.requestId),
              eq(permissionAccessRequests.orgId, args.orgId),
              visibleZeroAgentCondition(args.userId),
            ),
          )
          .limit(1);

        if (!row) {
          return [];
        }

        const names = await requesterNameMap(client, [
          row.request.requesterUserId,
        ]);
        return [formatPermissionAccessRequest(row.request, names)];
      }

      const agentId = args.agentId;
      if (!agentId) {
        return [];
      }

      const [agent] = await db
        .select({ owner: zeroAgents.owner, visibility: zeroAgents.visibility })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.orgId, args.orgId),
            eq(zeroAgents.id, agentId),
            visibleZeroAgentCondition(args.userId),
          ),
        )
        .limit(1);

      const isOwnerOrAdmin =
        agent?.owner === args.userId ||
        (agent?.visibility !== "private" && args.orgRole === "admin");

      const conditions = [
        eq(permissionAccessRequests.agentId, agentId),
        eq(permissionAccessRequests.orgId, args.orgId),
      ];
      if (!isOwnerOrAdmin) {
        conditions.push(
          eq(permissionAccessRequests.requesterUserId, args.userId),
        );
      }
      if (args.status) {
        conditions.push(eq(permissionAccessRequests.status, args.status));
      }

      const rows = await db
        .select()
        .from(permissionAccessRequests)
        .where(and(...conditions));

      const names = await requesterNameMap(
        client,
        rows.map((row) => {
          return row.requesterUserId;
        }),
      );

      return rows.map((row) => {
        return formatPermissionAccessRequest(row, names);
      });
    },
  );
}
