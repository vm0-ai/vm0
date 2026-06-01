import { command } from "ccstate";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import {
  type FirewallPolicies,
  UNKNOWN_PERMISSION_GRANT,
} from "@vm0/connectors/firewall-types";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type {
  UpsertUserPermissionGrantRequest,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { notFound } from "../../lib/error";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

type UserPermissionGrantRow = typeof userPermissionGrants.$inferSelect;

interface UserPermissionGrantScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface UpsertUserPermissionGrantArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly grant: UpsertUserPermissionGrantRequest;
}

type NotFoundResponse = ReturnType<typeof notFound>;

type ValidationErrorResponse = {
  readonly status: 400;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: "VALIDATION_ERROR";
    };
  };
};

type ListUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly UserPermissionGrantResponse[];
    }
  | NotFoundResponse;

type UpsertUserPermissionGrantResult =
  | {
      readonly kind: "ok";
      readonly grant: UserPermissionGrantResponse;
    }
  | NotFoundResponse
  | ValidationErrorResponse;

function validationError(message: string): ValidationErrorResponse {
  return {
    status: 400 as const,
    body: {
      error: {
        message,
        code: "VALIDATION_ERROR" as const,
      },
    },
  };
}

function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

async function findVisibleAgent(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
): Promise<{ readonly id: string } | null> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, scope.orgId),
        eq(zeroAgents.id, scope.agentId),
        visibleZeroAgentCondition(scope.userId),
      ),
    )
    .limit(1);
  return agent ?? null;
}

function validPermissionNames(connectorRef: string): Set<string> | null {
  if (!isFirewallConnectorType(connectorRef)) {
    return null;
  }

  const config = getConnectorFirewall(connectorRef);
  const names = new Set<string>();
  for (const api of config.apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
    }
  }
  return names;
}

function validateGrantTarget(
  connectorRef: string,
  permission: string,
): ValidationErrorResponse | null {
  const names = validPermissionNames(connectorRef);
  if (!names) {
    return validationError(`Unknown connector ref: ${connectorRef}`);
  }

  if (permission === UNKNOWN_PERMISSION_GRANT) {
    return null;
  }

  if (!names.has(permission)) {
    return validationError(
      `Unknown permission "${permission}" for connector "${connectorRef}"`,
    );
  }

  return null;
}

function activeGrantCondition(checkedAt: Date) {
  return or(
    isNull(userPermissionGrants.expiresAt),
    gt(userPermissionGrants.expiresAt, checkedAt),
  );
}

function formatUserPermissionGrant(
  row: Pick<
    UserPermissionGrantRow,
    | "agentId"
    | "connectorRef"
    | "permission"
    | "action"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >,
): UserPermissionGrantResponse {
  return {
    agentId: row.agentId,
    connectorRef: row.connectorRef,
    permission: row.permission,
    action: row.action,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadActiveUserPermissionGrants(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  checkedAt: Date = nowDate(),
): Promise<readonly UserPermissionGrantRow[]> {
  return await db
    .select()
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, scope.orgId),
        eq(userPermissionGrants.userId, scope.userId),
        eq(userPermissionGrants.agentId, scope.agentId),
        activeGrantCondition(checkedAt),
      ),
    )
    .orderBy(
      asc(userPermissionGrants.connectorRef),
      asc(userPermissionGrants.permission),
    );
}

export function foldUserPermissionGrantsToFirewallPolicies(
  grants: readonly Pick<
    UserPermissionGrantRow,
    "connectorRef" | "permission" | "action"
  >[],
): FirewallPolicies | null {
  const policies: FirewallPolicies = {};

  for (const grant of grants) {
    const existing = policies[grant.connectorRef] ?? { policies: {} };
    if (grant.permission === UNKNOWN_PERMISSION_GRANT) {
      policies[grant.connectorRef] = {
        ...existing,
        unknownPolicy: grant.action,
      };
      continue;
    }

    existing.policies[grant.permission] = grant.action;
    policies[grant.connectorRef] = existing;
  }

  return Object.keys(policies).length > 0 ? policies : null;
}

async function visibleAgentOrNotFound(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
): Promise<NotFoundResponse | null> {
  return (await findVisibleAgent(db, scope))
    ? null
    : notFound(`Agent not found: ${scope.agentId}`);
}

async function lockVisibleAgentForUpdate(
  db: Pick<Db, "select">,
  scope: UserPermissionGrantScope,
): Promise<{ readonly id: string } | null> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, scope.orgId),
        eq(zeroAgents.id, scope.agentId),
        visibleZeroAgentCondition(scope.userId),
      ),
    )
    .for("update")
    .limit(1);
  return agent ?? null;
}

function expiresAtFromTtl(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

async function upsertVisibleGrantRow(
  db: Db,
  args: UpsertUserPermissionGrantArgs,
): Promise<UserPermissionGrantRow | NotFoundResponse> {
  return await db.transaction(async (tx) => {
    const visibleAgent = await lockVisibleAgentForUpdate(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.grant.agentId,
    });
    if (!visibleAgent) {
      return notFound(`Agent not found: ${args.grant.agentId}`);
    }

    const timestamp = nowDate();
    const expiresAt = expiresAtFromTtl(timestamp, args.grant.ttlSeconds);
    const [row] = await tx
      .insert(userPermissionGrants)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.grant.agentId,
        connectorRef: args.grant.connectorRef,
        permission: args.grant.permission,
        action: args.grant.action,
        expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          userPermissionGrants.orgId,
          userPermissionGrants.userId,
          userPermissionGrants.agentId,
          userPermissionGrants.connectorRef,
          userPermissionGrants.permission,
        ],
        set: {
          action: args.grant.action,
          expiresAt,
          updatedAt: timestamp,
        },
      })
      .returning();

    if (!row) {
      throw new Error("User permission grant upsert did not return a row");
    }
    return row;
  });
}

export const listUserPermissionGrants$ = command(
  async (
    { get },
    scope: UserPermissionGrantScope,
    signal: AbortSignal,
  ): Promise<ListUserPermissionGrantsResult> => {
    const db = get(db$);
    const visibleError = await visibleAgentOrNotFound(db, scope);
    signal.throwIfAborted();
    if (visibleError) {
      return visibleError;
    }

    const grants = await loadActiveUserPermissionGrants(db, scope);
    signal.throwIfAborted();

    return {
      kind: "ok" as const,
      grants: grants.map(formatUserPermissionGrant),
    };
  },
);

export const upsertUserPermissionGrant$ = command(
  async (
    { set },
    args: UpsertUserPermissionGrantArgs,
    signal: AbortSignal,
  ): Promise<UpsertUserPermissionGrantResult> => {
    const validation = validateGrantTarget(
      args.grant.connectorRef,
      args.grant.permission,
    );
    if (validation) {
      return validation;
    }

    const writeDb = set(writeDb$);
    const row = await upsertVisibleGrantRow(writeDb, args);
    signal.throwIfAborted();

    if ("status" in row) {
      return row;
    }

    return {
      kind: "ok" as const,
      grant: formatUserPermissionGrant(row),
    };
  },
);
