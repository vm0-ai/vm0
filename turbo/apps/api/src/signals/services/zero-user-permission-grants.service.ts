import { command } from "ccstate";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import {
  userPermissionGrants,
  type UserPermissionGrantTargetType,
} from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type {
  ApplyCompactUserPermissionGrant,
  ApplyCompactUserPermissionGrantsRequest,
  CompactUserPermissionGrantResponse,
  CompactUserPermissionGrantsQuery,
  ResetUserPermissionGrantsQuery,
  UpsertUserPermissionGrantRequest,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
  UserPermissionGrantTarget,
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

interface UpsertUserPermissionGrantArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly grant: UpsertUserPermissionGrantRequest;
}

interface CompactUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly query: CompactUserPermissionGrantsQuery;
}

interface ApplyCompactUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly apply: ApplyCompactUserPermissionGrantsRequest;
}

interface ResetUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly reset: ResetUserPermissionGrantsQuery;
}

interface GrantTargetStorage {
  readonly targetType: UserPermissionGrantTargetType;
  readonly permission: string;
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

type CompactUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly CompactUserPermissionGrantResponse[];
    }
  | NotFoundResponse;

type UpsertUserPermissionGrantResult =
  | {
      readonly kind: "ok";
      readonly grant: UserPermissionGrantResponse;
    }
  | NotFoundResponse
  | ValidationErrorResponse;

type ApplyCompactUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly CompactUserPermissionGrantResponse[];
    }
  | NotFoundResponse
  | ValidationErrorResponse;

type ResetUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
    }
  | NotFoundResponse
  | ValidationErrorResponse;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NON_PERMISSION_TARGET_PLACEHOLDER = "";

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

function targetLabel(target: UserPermissionGrantTarget): string {
  switch (target.kind) {
    case "connector-default": {
      return "connector default";
    }
    case "permission": {
      return `permission "${target.permission}"`;
    }
    case "unknown-endpoint": {
      return "unknown endpoint";
    }
  }
}

function grantTargetStorage(
  target: UserPermissionGrantTarget,
): GrantTargetStorage {
  switch (target.kind) {
    case "connector-default": {
      return {
        targetType: "connector-default",
        permission: NON_PERMISSION_TARGET_PLACEHOLDER,
      };
    }
    case "permission": {
      return {
        targetType: "permission",
        permission: target.permission,
      };
    }
    case "unknown-endpoint": {
      return {
        targetType: "unknown-endpoint",
        permission: NON_PERMISSION_TARGET_PLACEHOLDER,
      };
    }
  }
}

function legacyPermissionTarget(permission: string): UserPermissionGrantTarget {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? { kind: "unknown-endpoint" }
    : { kind: "permission", permission };
}

export function userPermissionGrantRowTarget(
  row: Pick<UserPermissionGrantRow, "targetType" | "permission">,
): UserPermissionGrantTarget {
  if (
    row.targetType === "unknown-endpoint" ||
    (row.targetType === "permission" &&
      row.permission === UNKNOWN_PERMISSION_GRANT)
  ) {
    return { kind: "unknown-endpoint" };
  }
  if (row.targetType === "connector-default") {
    return { kind: "connector-default" };
  }
  return { kind: "permission", permission: row.permission };
}

function legacyPermissionForRow(
  row: Pick<UserPermissionGrantRow, "targetType" | "permission">,
): string | null {
  const target = userPermissionGrantRowTarget(row);
  switch (target.kind) {
    case "connector-default": {
      return null;
    }
    case "permission": {
      return target.permission;
    }
    case "unknown-endpoint": {
      return UNKNOWN_PERMISSION_GRANT;
    }
  }
}

function validateGrantTarget(
  connectorRef: string,
  target: UserPermissionGrantTarget,
): ValidationErrorResponse | null {
  const names = validPermissionNames(connectorRef);
  if (!names) {
    return validationError(`Unknown connector ref: ${connectorRef}`);
  }

  if (target.kind !== "permission") {
    return null;
  }

  if (!names.has(target.permission)) {
    return validationError(
      `Unknown permission "${target.permission}" for connector "${connectorRef}"`,
    );
  }

  return null;
}

function validateConnectorRef(
  connectorRef: string,
): ValidationErrorResponse | null {
  if (isFirewallConnectorType(connectorRef)) {
    return null;
  }
  return validationError(`Unknown connector ref: ${connectorRef}`);
}

function validateGrantExpiration(
  grant: UpsertUserPermissionGrantRequest,
): ValidationErrorResponse | null {
  if (grant.action === "allow" || grant.expiresIn === undefined) {
    return null;
  }
  return validationError(
    "Permission grant expiration is only supported for allow grants",
  );
}

function validateCompactGrantExpiration(
  grant: ApplyCompactUserPermissionGrant,
): ValidationErrorResponse | null {
  if (grant.action === "allow" || grant.expiresIn === undefined) {
    return null;
  }
  return validationError(
    "Permission grant expiration is only supported for allow grants",
  );
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
    | "targetType"
    | "permission"
    | "action"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >,
): UserPermissionGrantResponse | null {
  const permission = legacyPermissionForRow(row);
  if (!permission) {
    return null;
  }
  return {
    agentId: row.agentId,
    connectorRef: row.connectorRef,
    permission,
    action: row.action,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatCompactUserPermissionGrant(
  row: Pick<
    UserPermissionGrantRow,
    | "agentId"
    | "connectorRef"
    | "targetType"
    | "permission"
    | "action"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >,
): CompactUserPermissionGrantResponse {
  return {
    agentId: row.agentId,
    connectorRef: row.connectorRef,
    target: userPermissionGrantRowTarget(row),
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
      asc(userPermissionGrants.targetType),
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

function grantTargetKey(target: UserPermissionGrantTarget): string {
  switch (target.kind) {
    case "connector-default": {
      return "connector-default";
    }
    case "permission": {
      return `permission:${target.permission}`;
    }
    case "unknown-endpoint": {
      return "unknown-endpoint";
    }
  }
}

function grantRowTargetMatches(
  target: UserPermissionGrantTarget,
  row: Pick<UserPermissionGrantRow, "targetType" | "permission">,
): boolean {
  return (
    grantTargetKey(target) === grantTargetKey(userPermissionGrantRowTarget(row))
  );
}

function grantTargetCondition(target: UserPermissionGrantTarget) {
  const storage = grantTargetStorage(target);
  const canonical = and(
    eq(userPermissionGrants.targetType, storage.targetType),
    eq(userPermissionGrants.permission, storage.permission),
  );
  if (target.kind !== "unknown-endpoint") {
    return canonical;
  }
  return or(
    canonical,
    and(
      eq(userPermissionGrants.targetType, "permission"),
      eq(userPermissionGrants.permission, UNKNOWN_PERMISSION_GRANT),
    ),
  );
}

function targetValues(target: UserPermissionGrantTarget): GrantTargetStorage {
  return grantTargetStorage(target);
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

    const target = legacyPermissionTarget(args.grant.permission);
    const timestamp = nowDate();
    const [existing] = await tx
      .select()
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, args.orgId),
          eq(userPermissionGrants.userId, args.userId),
          eq(userPermissionGrants.agentId, args.grant.agentId),
          eq(userPermissionGrants.connectorRef, args.grant.connectorRef),
          grantTargetCondition(target),
        ),
      )
      .for("update")
      .limit(1);
    const targetStorage = targetValues(target);
    const expiresAt = resolvedExpiresAt({
      action: args.grant.action,
      expiresIn: args.grant.expiresIn,
      existing,
      timestamp,
    });

    const [row] = existing
      ? await tx
          .update(userPermissionGrants)
          .set({
            targetType: targetStorage.targetType,
            permission: targetStorage.permission,
            action: args.grant.action,
            expiresAt,
            updatedAt: timestamp,
          })
          .where(eq(userPermissionGrants.id, existing.id))
          .returning()
      : await tx
          .insert(userPermissionGrants)
          .values({
            orgId: args.orgId,
            userId: args.userId,
            agentId: args.grant.agentId,
            connectorRef: args.grant.connectorRef,
            targetType: targetStorage.targetType,
            permission: targetStorage.permission,
            action: args.grant.action,
            expiresAt,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();

    if (!row) {
      throw new Error("User permission grant upsert did not return a row");
    }
    return row;
  });
}

function validateCompactApply(
  apply: ApplyCompactUserPermissionGrantsRequest,
): ValidationErrorResponse | null {
  const connectorValidation = validateConnectorRef(apply.connectorRef);
  if (connectorValidation) {
    return connectorValidation;
  }

  const seenTargets = new Set<string>();
  for (const grant of apply.grants) {
    const targetValidation = validateGrantTarget(
      apply.connectorRef,
      grant.target,
    );
    if (targetValidation) {
      return targetValidation;
    }

    const expirationValidation = validateCompactGrantExpiration(grant);
    if (expirationValidation) {
      return expirationValidation;
    }

    const key = grantTargetKey(grant.target);
    if (seenTargets.has(key)) {
      return validationError(
        `Duplicate compact permission grant target: ${targetLabel(grant.target)}`,
      );
    }
    seenTargets.add(key);
  }
  return null;
}

async function applyVisibleCompactGrantRows(
  db: Db,
  args: ApplyCompactUserPermissionGrantsArgs,
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
    const existingRows = await tx
      .select()
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, args.orgId),
          eq(userPermissionGrants.userId, args.userId),
          eq(userPermissionGrants.agentId, args.apply.agentId),
          eq(userPermissionGrants.connectorRef, args.apply.connectorRef),
        ),
      )
      .for("update");

    await tx
      .delete(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, args.orgId),
          eq(userPermissionGrants.userId, args.userId),
          eq(userPermissionGrants.agentId, args.apply.agentId),
          eq(userPermissionGrants.connectorRef, args.apply.connectorRef),
        ),
      );

    if (args.apply.grants.length === 0) {
      return [];
    }

    const values = args.apply.grants.map((grant) => {
      const targetStorage = targetValues(grant.target);
      const existing = existingRows.find((row) => {
        return grantRowTargetMatches(grant.target, row);
      });
      return {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.apply.agentId,
        connectorRef: args.apply.connectorRef,
        targetType: targetStorage.targetType,
        permission: targetStorage.permission,
        action: grant.action,
        expiresAt: resolvedExpiresAt({
          action: grant.action,
          expiresIn: grant.expiresIn,
          existing,
          timestamp,
        }),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
    });

    return await tx.insert(userPermissionGrants).values(values).returning();
  });
}

async function resetVisibleConnectorGrantRows(
  db: Db,
  args: ResetUserPermissionGrantsArgs,
): Promise<NotFoundResponse | null> {
  return await db.transaction(async (tx) => {
    const visibleAgent = await lockVisibleAgentForUpdate(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.reset.agentId,
    });
    if (!visibleAgent) {
      return notFound(`Agent not found: ${args.reset.agentId}`);
    }

    await tx
      .delete(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, args.orgId),
          eq(userPermissionGrants.userId, args.userId),
          eq(userPermissionGrants.agentId, args.reset.agentId),
          eq(userPermissionGrants.connectorRef, args.reset.connectorRef),
        ),
      );
    return null;
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
      grants: grants.flatMap((grant) => {
        const formatted = formatUserPermissionGrant(grant);
        return formatted ? [formatted] : [];
      }),
    };
  },
);

export const listCompactUserPermissionGrants$ = command(
  async (
    { get },
    args: CompactUserPermissionGrantsArgs,
    signal: AbortSignal,
  ): Promise<CompactUserPermissionGrantsResult> => {
    const db = get(db$);
    const visibleError = await visibleAgentOrNotFound(db, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.query.agentId,
    });
    signal.throwIfAborted();
    if (visibleError) {
      return visibleError;
    }

    const grants = await loadActiveUserPermissionGrants(db, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.query.agentId,
    });
    signal.throwIfAborted();

    return {
      kind: "ok" as const,
      grants: grants.map(formatCompactUserPermissionGrant),
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
      legacyPermissionTarget(args.grant.permission),
    );
    if (validation) {
      return validation;
    }
    const expirationValidation = validateGrantExpiration(args.grant);
    if (expirationValidation) {
      return expirationValidation;
    }

    const writeDb = set(writeDb$);
    const row = await upsertVisibleGrantRow(writeDb, args);
    signal.throwIfAborted();

    if ("status" in row) {
      return row;
    }

    const formatted = formatUserPermissionGrant(row);
    if (!formatted) {
      throw new Error("Legacy user permission grant upsert returned no grant");
    }

    return {
      kind: "ok" as const,
      grant: formatted,
    };
  },
);

export const applyCompactUserPermissionGrants$ = command(
  async (
    { set },
    args: ApplyCompactUserPermissionGrantsArgs,
    signal: AbortSignal,
  ): Promise<ApplyCompactUserPermissionGrantsResult> => {
    const validation = validateCompactApply(args.apply);
    if (validation) {
      return validation;
    }

    const writeDb = set(writeDb$);
    const rows = await applyVisibleCompactGrantRows(writeDb, args);
    signal.throwIfAborted();

    if ("status" in rows) {
      return rows;
    }

    return {
      kind: "ok" as const,
      grants: rows.map(formatCompactUserPermissionGrant),
    };
  },
);

export const resetUserPermissionGrants$ = command(
  async (
    { set },
    args: ResetUserPermissionGrantsArgs,
    signal: AbortSignal,
  ): Promise<ResetUserPermissionGrantsResult> => {
    const validation = validateConnectorRef(args.reset.connectorRef);
    if (validation) {
      return validation;
    }

    const writeDb = set(writeDb$);
    const error = await resetVisibleConnectorGrantRows(writeDb, args);
    signal.throwIfAborted();

    if (error) {
      return error;
    }

    return { kind: "ok" as const };
  },
);
