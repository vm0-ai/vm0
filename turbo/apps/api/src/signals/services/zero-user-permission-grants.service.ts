import { command } from "ccstate";
import { loadFirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { workflowUserPermissionGrants } from "@vm0/db/schema/workflow-user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
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
type WorkflowUserPermissionGrantRow =
  typeof workflowUserPermissionGrants.$inferSelect;
type StoredPermissionGrantRow =
  | UserPermissionGrantRow
  | WorkflowUserPermissionGrantRow;
type UserPermissionGrantAction = UserPermissionGrantResponse["action"];

interface UserPermissionGrantBaseScope {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: string;
}

type UserPermissionGrantScope = UserPermissionGrantBaseScope &
  (
    | { readonly agentId: string; readonly workflowId?: never }
    | { readonly workflowId: string; readonly agentId?: never }
  );

type UserPermissionGrantAgentScope = UserPermissionGrantBaseScope & {
  readonly agentId: string;
  readonly workflowId?: never;
};

type UserPermissionGrantWorkflowScope = UserPermissionGrantBaseScope & {
  readonly workflowId: string;
  readonly agentId?: never;
};

type ApplyUserPermissionGrantsAgentRequest =
  ApplyUserPermissionGrantsRequest & {
    readonly agentId: string;
    readonly workflowId?: never;
  };

type ApplyUserPermissionGrantsWorkflowRequest =
  ApplyUserPermissionGrantsRequest & {
    readonly workflowId: string;
    readonly agentId?: never;
  };

interface ApplyUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: string;
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

function isWorkflowGrantScope(
  scope: UserPermissionGrantScope,
): scope is UserPermissionGrantWorkflowScope {
  return scope.workflowId !== undefined;
}

function isWorkflowGrantApply(
  apply: ApplyUserPermissionGrantsRequest,
): apply is ApplyUserPermissionGrantsWorkflowRequest {
  return apply.workflowId !== undefined;
}

function requireAgentGrantApply(
  apply: ApplyUserPermissionGrantsRequest,
): ApplyUserPermissionGrantsAgentRequest {
  if (apply.agentId === undefined) {
    throw new Error("Expected agent permission grant scope");
  }
  return apply as ApplyUserPermissionGrantsAgentRequest;
}

async function findVisibleAgent(
  db: ReadonlyDb,
  scope: UserPermissionGrantBaseScope & { readonly agentId: string },
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

async function findVisibleWorkflow(
  db: ReadonlyDb,
  scope: UserPermissionGrantBaseScope & { readonly workflowId: string },
): Promise<{ readonly id: string } | null> {
  const [workflow] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .innerJoin(zeroAgents, eq(zeroWorkflows.agentId, zeroAgents.id))
    .where(
      and(
        eq(zeroWorkflows.orgId, scope.orgId),
        eq(zeroWorkflows.id, scope.workflowId),
        or(
          and(
            eq(zeroWorkflows.visibility, "public"),
            visibleZeroAgentCondition(scope.userId),
          ),
          eq(zeroWorkflows.ownerUserId, scope.userId),
          scope.role === "admin"
            ? and(
                eq(zeroWorkflows.requestToPublish, true),
                eq(zeroAgents.visibility, "public"),
              )
            : and(
                eq(zeroWorkflows.requestToPublish, true),
                eq(zeroAgents.owner, scope.userId),
              ),
        ),
      ),
    )
    .limit(1);
  return workflow ?? null;
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

function activeWorkflowGrantCondition(checkedAt: Date) {
  return or(
    isNull(workflowUserPermissionGrants.expiresAt),
    gt(workflowUserPermissionGrants.expiresAt, checkedAt),
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
  readonly existing: StoredPermissionGrantRow | undefined;
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
    StoredPermissionGrantRow,
    | "connectorRef"
    | "permission"
    | "action"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >,
  scope:
    | { readonly agentId: string; readonly workflowId?: never }
    | { readonly workflowId: string; readonly agentId?: never },
): UserPermissionGrantResponse {
  return {
    ...scope,
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
): Promise<readonly StoredPermissionGrantRow[]> {
  if (isWorkflowGrantScope(scope)) {
    return await db
      .select()
      .from(workflowUserPermissionGrants)
      .where(
        and(
          eq(workflowUserPermissionGrants.orgId, scope.orgId),
          eq(workflowUserPermissionGrants.userId, scope.userId),
          eq(workflowUserPermissionGrants.workflowId, scope.workflowId),
          activeWorkflowGrantCondition(checkedAt),
        ),
      )
      .orderBy(
        asc(workflowUserPermissionGrants.connectorRef),
        asc(workflowUserPermissionGrants.permission),
      );
  }

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
  scope: UserPermissionGrantBaseScope & { readonly agentId: string },
): Promise<NotFoundResponse | null> {
  return (await findVisibleAgent(db, scope))
    ? null
    : notFound(`Agent not found: ${scope.agentId}`);
}

async function visibleWorkflowOrNotFound(
  db: ReadonlyDb,
  scope: UserPermissionGrantBaseScope & { readonly workflowId: string },
): Promise<NotFoundResponse | null> {
  return (await findVisibleWorkflow(db, scope))
    ? null
    : notFound(`Workflow not found: ${scope.workflowId}`);
}

async function lockVisibleAgentForUpdate(
  db: Pick<Db, "select">,
  scope: UserPermissionGrantBaseScope & { readonly agentId: string },
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

async function lockVisibleWorkflowForUpdate(
  db: Pick<Db, "select">,
  scope: UserPermissionGrantBaseScope & { readonly workflowId: string },
): Promise<{ readonly id: string } | null> {
  const [workflow] = await db
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .innerJoin(zeroAgents, eq(zeroWorkflows.agentId, zeroAgents.id))
    .where(
      and(
        eq(zeroWorkflows.orgId, scope.orgId),
        eq(zeroWorkflows.id, scope.workflowId),
        or(
          and(
            eq(zeroWorkflows.visibility, "public"),
            visibleZeroAgentCondition(scope.userId),
          ),
          eq(zeroWorkflows.ownerUserId, scope.userId),
          scope.role === "admin"
            ? and(
                eq(zeroWorkflows.requestToPublish, true),
                eq(zeroAgents.visibility, "public"),
              )
            : and(
                eq(zeroWorkflows.requestToPublish, true),
                eq(zeroAgents.owner, scope.userId),
              ),
        ),
      ),
    )
    .for("update")
    .limit(1);
  return workflow ?? null;
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
): Promise<readonly StoredPermissionGrantRow[] | NotFoundResponse> {
  if (isWorkflowGrantApply(args.apply)) {
    return await applyVisibleWorkflowGrantRows(db, args, args.apply.workflowId);
  }
  return await applyVisibleAgentGrantRows(
    db,
    args,
    requireAgentGrantApply(args.apply).agentId,
  );
}

async function applyVisibleAgentGrantRows(
  db: Db,
  args: ApplyUserPermissionGrantsArgs,
  agentId: string,
): Promise<readonly UserPermissionGrantRow[] | NotFoundResponse> {
  return await db.transaction(async (tx) => {
    const visibleAgent = await lockVisibleAgentForUpdate(tx, {
      orgId: args.orgId,
      userId: args.userId,
      role: args.role,
      agentId,
    });
    if (!visibleAgent) {
      return notFound(`Agent not found: ${agentId}`);
    }

    const timestamp = nowDate();
    const connectorScopeCondition = and(
      eq(userPermissionGrants.orgId, args.orgId),
      eq(userPermissionGrants.userId, args.userId),
      eq(userPermissionGrants.agentId, agentId),
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
                eq(userPermissionGrants.agentId, agentId),
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
              agentId,
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

async function applyVisibleWorkflowGrantRows(
  db: Db,
  args: ApplyUserPermissionGrantsArgs,
  workflowId: string,
): Promise<readonly WorkflowUserPermissionGrantRow[] | NotFoundResponse> {
  return await db.transaction(async (tx) => {
    const visibleWorkflow = await lockVisibleWorkflowForUpdate(tx, {
      orgId: args.orgId,
      userId: args.userId,
      role: args.role,
      workflowId,
    });
    if (!visibleWorkflow) {
      return notFound(`Workflow not found: ${workflowId}`);
    }

    const timestamp = nowDate();
    const connectorScopeCondition = and(
      eq(workflowUserPermissionGrants.orgId, args.orgId),
      eq(workflowUserPermissionGrants.userId, args.userId),
      eq(workflowUserPermissionGrants.workflowId, workflowId),
      eq(workflowUserPermissionGrants.connectorRef, args.apply.connectorRef),
    );

    if (args.apply.mode === "replace") {
      await tx
        .delete(workflowUserPermissionGrants)
        .where(connectorScopeCondition);
    }

    if (args.apply.grants.length === 0) {
      return [];
    }

    const existingRows =
      args.apply.mode === "replace"
        ? []
        : await tx
            .select()
            .from(workflowUserPermissionGrants)
            .where(connectorScopeCondition)
            .for("update");
    const existingRowsByPermission = new Map(
      existingRows.map((row) => {
        return [row.permission, row] as const;
      }),
    );
    const rows: WorkflowUserPermissionGrantRow[] = [];
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
            .update(workflowUserPermissionGrants)
            .set({
              action: grant.action,
              expiresAt,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(workflowUserPermissionGrants.orgId, args.orgId),
                eq(workflowUserPermissionGrants.userId, args.userId),
                eq(workflowUserPermissionGrants.workflowId, workflowId),
                eq(
                  workflowUserPermissionGrants.connectorRef,
                  args.apply.connectorRef,
                ),
                eq(workflowUserPermissionGrants.permission, grant.permission),
              ),
            )
            .returning()
        : await tx
            .insert(workflowUserPermissionGrants)
            .values({
              orgId: args.orgId,
              userId: args.userId,
              workflowId,
              connectorRef: args.apply.connectorRef,
              permission: grant.permission,
              action: grant.action,
              expiresAt,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
      if (!row) {
        throw new Error(
          "Workflow user permission grant apply did not return a row",
        );
      }
      rows.push(row);
    }
    return rows;
  });
}

function permissionGrantResponseScope(
  scope: UserPermissionGrantScope,
):
  | { readonly agentId: string; readonly workflowId?: never }
  | { readonly workflowId: string; readonly agentId?: never } {
  return isWorkflowGrantScope(scope)
    ? { workflowId: scope.workflowId }
    : { agentId: scope.agentId };
}

function applyPermissionGrantResponseScope(
  args: ApplyUserPermissionGrantsArgs,
):
  | { readonly agentId: string; readonly workflowId?: never }
  | { readonly workflowId: string; readonly agentId?: never } {
  return isWorkflowGrantApply(args.apply)
    ? { workflowId: args.apply.workflowId }
    : { agentId: requireAgentGrantApply(args.apply).agentId };
}

export const listUserPermissionGrants$ = command(
  async (
    { get },
    scope: UserPermissionGrantScope,
    signal: AbortSignal,
  ): Promise<ListUserPermissionGrantsResult> => {
    const db = get(db$);
    const visibleError = isWorkflowGrantScope(scope)
      ? await visibleWorkflowOrNotFound(db, {
          orgId: scope.orgId,
          userId: scope.userId,
          role: scope.role,
          workflowId: scope.workflowId,
        })
      : await visibleAgentOrNotFound(db, {
          orgId: scope.orgId,
          userId: scope.userId,
          role: scope.role,
          agentId: scope.agentId,
        });
    signal.throwIfAborted();
    if (visibleError) {
      return visibleError;
    }

    const grants = await loadActiveUserPermissionGrants(db, scope);
    signal.throwIfAborted();
    const responseScope = permissionGrantResponseScope(scope);

    return {
      kind: "ok" as const,
      grants: grants.map((grant) => {
        return formatUserPermissionGrant(grant, responseScope);
      }),
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
    const responseScope = applyPermissionGrantResponseScope(args);

    return {
      kind: "ok" as const,
      grants: rows.map((grant) => {
        return formatUserPermissionGrant(grant, responseScope);
      }),
    };
  },
);
