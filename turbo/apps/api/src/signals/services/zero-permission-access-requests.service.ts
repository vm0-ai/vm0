import { command, computed, type Computed } from "ccstate";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import type { RawPermissionPolicies } from "@vm0/connectors/firewall-types";
import { and, eq, or } from "drizzle-orm";
import type {
  PermissionAccessRequestResponse,
  ResolvePermissionAccessRequest,
} from "@vm0/api-contracts/contracts/zero-agents";
import { permissionAccessRequests } from "@vm0/db/schema/permission-access-request";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { db$, writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import {
  createSlackClient,
  postMessage,
} from "../external/slack-message-client";
import { nowDate } from "../external/time";
import type { ApiOrgRole } from "../../types/auth";
import { decryptSecretValue } from "./crypto.utils";

type PermissionAccessRequestRow = typeof permissionAccessRequests.$inferSelect;
type ForbiddenResponse = NonNullable<ReturnType<typeof requireAgentPermission>>;

const log = logger("zero-permission-access-requests");

interface ListPermissionAccessRequestsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole: ApiOrgRole | undefined;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly status?: string;
}

interface ResolvePermissionAccessRequestArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role: string;
  readonly requestId: string;
  readonly action: ResolvePermissionAccessRequest["action"];
}

type AlreadyResolvedResponse = {
  readonly status: 400;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: "ALREADY_RESOLVED";
    };
  };
};

type ResolvePermissionAccessRequestResult =
  | { readonly kind: "ok"; readonly request: PermissionAccessRequestResponse }
  | ReturnType<typeof notFound>
  | ForbiddenResponse
  | AlreadyResolvedResponse;

function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

function alreadyResolved(status: string): AlreadyResolvedResponse {
  return {
    status: 400 as const,
    body: {
      error: {
        message: `Request already resolved with status: ${status}`,
        code: "ALREADY_RESOLVED",
      },
    },
  };
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
  nameMap: ReadonlyMap<string, string> = new Map(),
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

function connectorLabel(connectorRef: string): string {
  const config = CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];
  return config?.label ?? connectorRef;
}

function buildReviewUrl(agentId: string, requestId: string): string {
  const appUrl = env("VM0_WEB_URL");
  return `${appUrl}/agents/${agentId}/permissions?request=${requestId}`;
}

async function notifyRequesterOfResolution(
  db: Db,
  params: {
    readonly orgId: string;
    readonly requestId: string;
    readonly agentId: string;
    readonly agentDisplayName: string;
    readonly requesterUserId: string;
    readonly permission: string;
    readonly connectorRef: string;
    readonly action: string;
    readonly resolution: ResolvePermissionAccessRequest["action"];
  },
): Promise<void> {
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, params.orgId))
    .limit(1);
  if (!installation) {
    return;
  }

  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, params.requesterUserId),
        eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
      ),
    )
    .limit(1);
  if (!connection) {
    return;
  }

  const client = createSlackClient(
    decryptSecretValue(installation.encryptedBotToken),
  );
  const label = connectorLabel(params.connectorRef);
  const outcome = params.resolution === "approve" ? "approved" : "denied";
  const url = buildReviewUrl(params.agentId, params.requestId);
  await postMessage(
    client,
    connection.slackUserId,
    `Your request to ${params.action} "${params.permission}" on ${label} for agent ${params.agentDisplayName} has been ${outcome}. <${url}|View>`,
  );
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

export const resolvePermissionAccessRequest$ = command(
  async (
    { set },
    args: ResolvePermissionAccessRequestArgs,
    signal: AbortSignal,
  ): Promise<ResolvePermissionAccessRequestResult> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        request: permissionAccessRequests,
        agentOwner: zeroAgents.owner,
        agentDisplayName: zeroAgents.displayName,
        agentVisibility: zeroAgents.visibility,
      })
      .from(permissionAccessRequests)
      .innerJoin(
        zeroAgents,
        eq(permissionAccessRequests.agentId, zeroAgents.id),
      )
      .where(
        and(
          eq(permissionAccessRequests.id, args.requestId),
          eq(permissionAccessRequests.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!row) {
      return notFound(`Access request not found: ${args.requestId}`);
    }

    const forbidden = requireAgentPermission(
      row.agentOwner,
      { userId: args.userId, role: args.role },
      "resolve permission access requests",
      { visibility: row.agentVisibility },
    );
    if (forbidden) {
      return forbidden;
    }

    const existing = row.request;
    if (existing.status !== "pending") {
      return alreadyResolved(existing.status);
    }

    const resolvedAt = nowDate();
    const newStatus = args.action === "approve" ? "approved" : "rejected";
    const [updated] = await db.transaction(async (tx) => {
      if (args.action === "approve") {
        const [agent] = await tx
          .select({ permissionPolicies: zeroAgents.permissionPolicies })
          .from(zeroAgents)
          .where(eq(zeroAgents.id, existing.agentId))
          .limit(1);

        const currentPolicies: RawPermissionPolicies =
          agent?.permissionPolicies ?? {};
        const refPolicies = currentPolicies[existing.connectorRef] ?? {};
        const updatedPolicies: RawPermissionPolicies = {
          ...currentPolicies,
          [existing.connectorRef]: {
            ...refPolicies,
            [existing.permission]: existing.action,
          },
        };

        await tx
          .update(zeroAgents)
          .set({ permissionPolicies: updatedPolicies, updatedAt: resolvedAt })
          .where(eq(zeroAgents.id, existing.agentId));
      }

      return tx
        .update(permissionAccessRequests)
        .set({
          status: newStatus,
          resolvedBy: args.userId,
          resolvedAt,
        })
        .where(eq(permissionAccessRequests.id, args.requestId))
        .returning();
    });
    signal.throwIfAborted();

    if (!updated) {
      return notFound(`Access request not found: ${args.requestId}`);
    }

    log.debug(
      `Resolved permission access request: ${args.requestId} as ${newStatus}`,
    );

    void notifyRequesterOfResolution(db, {
      orgId: args.orgId,
      requestId: args.requestId,
      agentId: existing.agentId,
      agentDisplayName: row.agentDisplayName ?? existing.agentId,
      requesterUserId: existing.requesterUserId,
      permission: existing.permission,
      connectorRef: existing.connectorRef,
      action: existing.action,
      resolution: args.action,
    }).catch((error: unknown) => {
      log.error("Failed to notify requester of permission resolution", {
        error,
      });
    });

    return { kind: "ok", request: formatPermissionAccessRequest(updated) };
  },
);
