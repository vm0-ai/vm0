import { command } from "ccstate";
import { loadFirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type {
  ApplyUserPermissionGrantsRequest,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { notFound } from "../../lib/error";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

type UserPermissionGrantRow = typeof userPermissionGrants.$inferSelect;
type UserPermissionGrantAction = UserPermissionGrantResponse["action"];

interface UserPermissionGrantScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface ApplyUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly apply: ApplyUserPermissionGrantsRequest;
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

type ApplyUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly UserPermissionGrantResponse[];
    }
  | NotFoundResponse
  | ValidationErrorResponse;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function validateGrantExpiration(grant: {
  readonly action: UserPermissionGrantAction;
  readonly expiresIn?: UserPermissionGrantExpiresIn;
}): ValidationErrorResponse | null {
  if (grant.action !== "allow") {
    return grant.expiresIn === undefined
      ? null
      : validationError(
          "Permission grant expiration is only supported for allow grants",
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

function resolveGrantExpiresAt(
  expiresIn: UserPermissionGrantExpiresIn | undefined,
  timestamp: Date,
): Date | null {
  switch (expiresIn) {
    case "1h": {
      return new Date(timestamp.getTime() + HOUR_MS);
    }
    case "24h": {
      return new Date(timestamp.getTime() + DAY_MS);
    }
    case "7d": {
      return new Date(timestamp.getTime() + 7 * DAY_MS);
    }
    case "always":
    case undefined: {
      return null;
    }
  }
}

function preservedActiveGrantExpiresAt(
  expiresAt: Date | null,
  timestamp: Date,
): Date | null {
  if (!expiresAt) {
    return null;
  }
  return expiresAt.getTime() > timestamp.getTime() ? expiresAt : null;
}

function resolvedExpiresAt({
  action,
  expiresIn,
  existing,
  timestamp,
}: {
  readonly action: UserPermissionGrantAction;
  readonly expiresIn: UserPermissionGrantExpiresIn | undefined;
  readonly existing: UserPermissionGrantRow | undefined;
  readonly timestamp: Date;
}): Date | null {
  if (action !== "allow") {
    return null;
  }
  if (expiresIn !== undefined) {
    return resolveGrantExpiresAt(expiresIn, timestamp);
  }
  return preservedActiveGrantExpiresAt(
    existing?.action === "allow" ? existing.expiresAt : null,
    timestamp,
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

async function validateApplyUserPermissionGrants(
  apply: ApplyUserPermissionGrantsRequest,
): Promise<ValidationErrorResponse | null> {
  const index = await loadFirewallPermissionIndex(apply.connectorRef);
  if (!index) {
    return validationError(`Unknown connector ref: ${apply.connectorRef}`);
  }

  const seenPermissions = new Set<string>();
  for (const grant of apply.grants) {
    if (seenPermissions.has(grant.permission)) {
      return validationError(`Duplicate permission grant: ${grant.permission}`);
    }
    seenPermissions.add(grant.permission);

    if (
      grant.permission !== UNKNOWN_PERMISSION_GRANT &&
      !index.hasPermission(grant.permission)
    ) {
      return validationError(
        `Unknown permission "${grant.permission}" for connector "${apply.connectorRef}"`,
      );
    }

    const expirationValidation = validateGrantExpiration(grant);
    if (expirationValidation) {
      return expirationValidation;
    }
  }
  return null;
}

async function applyVisibleGrantRows(
  db: Db,
  args: ApplyUserPermissionGrantsArgs,
): Promise<readonly UserPermissionGrantRow[] | NotFoundResponse> {
  return await db.transaction(async (tx) => {
    const visibleAgent = await lockVisibleAgentForUpdate(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.apply.agentId,
    });
    if (!visibleAgent) {
      return notFound(`Agent not found: ${args.apply.agentId}`);
    }

    const timestamp = nowDate();
    const connectorScopeCondition = and(
      eq(userPermissionGrants.orgId, args.orgId),
      eq(userPermissionGrants.userId, args.userId),
      eq(userPermissionGrants.agentId, args.apply.agentId),
      eq(userPermissionGrants.connectorRef, args.apply.connectorRef),
    );

    if (args.apply.mode === "replace") {
      await tx.delete(userPermissionGrants).where(connectorScopeCondition);
    }

    if (args.apply.grants.length === 0) {
      return [];
    }

    const existingRows =
      args.apply.mode === "replace"
        ? []
        : await tx
            .select()
            .from(userPermissionGrants)
            .where(connectorScopeCondition)
            .for("update");
    const existingRowsByPermission = new Map(
      existingRows.map((row) => {
        return [row.permission, row] as const;
      }),
    );
    const rows: UserPermissionGrantRow[] = [];
    for (const grant of args.apply.grants) {
      const existing = existingRowsByPermission.get(grant.permission);
      const expiresAt = resolvedExpiresAt({
        action: grant.action,
        expiresIn: grant.expiresIn,
        existing,
        timestamp,
      });
      const [row] = existing
        ? await tx
            .update(userPermissionGrants)
            .set({
              action: grant.action,
              expiresAt,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(userPermissionGrants.orgId, args.orgId),
                eq(userPermissionGrants.userId, args.userId),
                eq(userPermissionGrants.agentId, args.apply.agentId),
                eq(userPermissionGrants.connectorRef, args.apply.connectorRef),
                eq(userPermissionGrants.permission, grant.permission),
              ),
            )
            .returning()
        : await tx
            .insert(userPermissionGrants)
            .values({
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.apply.agentId,
              connectorRef: args.apply.connectorRef,
              permission: grant.permission,
              action: grant.action,
              expiresAt,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
      if (!row) {
        throw new Error("User permission grant apply did not return a row");
      }
      rows.push(row);
    }
    return rows;
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

export const applyUserPermissionGrants$ = command(
  async (
    { set },
    args: ApplyUserPermissionGrantsArgs,
    signal: AbortSignal,
  ): Promise<ApplyUserPermissionGrantsResult> => {
    const validation = await validateApplyUserPermissionGrants(args.apply);
    signal.throwIfAborted();
    if (validation) {
      return validation;
    }

    const writeDb = set(writeDb$);
    const rows = await applyVisibleGrantRows(writeDb, args);
    signal.throwIfAborted();

    if ("status" in rows) {
      return rows;
    }

    return {
      kind: "ok" as const,
      grants: rows.map(formatUserPermissionGrant),
    };
  },
);
