import { command } from "ccstate";
import { loadFirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";
import { permissionGrantsToFirewallPolicies } from "@vm0/connectors/firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
  type NetworkPolicy,
} from "@vm0/connectors/firewall-types";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { and, asc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import type {
  ApplyUserPermissionGrantsRequest,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { notFound } from "../../lib/error";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishNetworkPolicyRefreshToRunnerGroup } from "../external/realtime";
import { nowDate } from "../external/time";

type UserPermissionGrantRow = typeof userPermissionGrants.$inferSelect;
type StoredPermissionGrantRow = UserPermissionGrantRow;
type UserPermissionGrantAction = UserPermissionGrantResponse["action"];

interface ActiveNetworkPolicyRefresh {
  readonly connectorRef: string;
  readonly networkPolicy: NetworkPolicy;
  readonly nextRefreshAt: string | null;
}

interface UserPermissionGrantBaseScope {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: string;
}

type UserPermissionGrantScope = UserPermissionGrantBaseScope & {
  readonly agentId: string;
};

type ApplyUserPermissionGrantsAgentRequest =
  ApplyUserPermissionGrantsRequest & {
    readonly agentId: string;
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

interface ActiveNetworkPolicyRefreshRun {
  readonly runId: string;
  readonly runnerGroup: string | null;
}

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

function networkPolicyForFirewallPolicy(
  permissionNames: readonly string[],
  policy: FirewallPolicy,
): NetworkPolicy {
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  for (const name of permissionNames) {
    const value = policy.policies[name];
    if (value === "allow") {
      allow.push(name);
    } else if (value === "deny") {
      deny.push(name);
    } else if (value === "ask") {
      ask.push(name);
    }
  }

  return {
    allow,
    deny,
    ask,
    unknownPolicy: policy.unknownPolicy ?? "allow",
  };
}

function defaultFirewallPolicyForIndex(
  index: NonNullable<Awaited<ReturnType<typeof loadFirewallPermissionIndex>>>,
): FirewallPolicy {
  const policies: FirewallPolicy["policies"] = {};
  for (const name of index.permissionNames) {
    policies[name] = index.policyResolver.permission(name);
  }
  return {
    policies,
    unknownPolicy: index.policyResolver.unknown(),
  };
}

function earliestTemporaryAllowExpiresAt(
  grants: readonly StoredPermissionGrantRow[],
  connectorRef: string,
): Date | null {
  let earliest: Date | null = null;
  for (const grant of grants) {
    if (
      grant.connectorRef !== connectorRef ||
      grant.action !== "allow" ||
      !grant.expiresAt
    ) {
      continue;
    }
    if (!earliest || grant.expiresAt.getTime() < earliest.getTime()) {
      earliest = grant.expiresAt;
    }
  }
  return earliest;
}

function resolvedConnectorFirewallPolicies(
  grants: readonly StoredPermissionGrantRow[],
): FirewallPolicies {
  return permissionGrantsToFirewallPolicies(grants) ?? {};
}

function isNetworkPolicyRefreshConnectorRef(connectorRef: string): boolean {
  return !connectorRef.startsWith("model-provider:");
}

export function networkPolicyRefreshConnectorRefs(
  connectorRefs: readonly string[],
): string[] {
  return [...new Set(connectorRefs.filter(isNetworkPolicyRefreshConnectorRef))];
}

export async function resolveActiveNetworkPolicyRefreshes(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  connectorRefs: readonly string[],
  checkedAt: Date = nowDate(),
): Promise<readonly ActiveNetworkPolicyRefresh[]> {
  if (connectorRefs.length === 0) {
    return [];
  }

  const uniqueConnectorRefs = networkPolicyRefreshConnectorRefs(connectorRefs);
  if (uniqueConnectorRefs.length === 0) {
    return [];
  }

  const grants = await loadActiveUserPermissionGrants(db, scope, checkedAt);
  const policies = resolvedConnectorFirewallPolicies(grants);

  const indexes = await Promise.all(
    uniqueConnectorRefs.map(async (connectorRef) => {
      return {
        connectorRef,
        index: await loadFirewallPermissionIndex(connectorRef),
      };
    }),
  );

  const refreshes: ActiveNetworkPolicyRefresh[] = [];
  for (const { connectorRef, index } of indexes) {
    if (!index) {
      continue;
    }

    const defaultPolicy = defaultFirewallPolicyForIndex(index);
    const overlay = policies[connectorRef];
    const policy: FirewallPolicy = overlay
      ? {
          policies: { ...defaultPolicy.policies, ...overlay.policies },
          unknownPolicy: overlay.unknownPolicy ?? defaultPolicy.unknownPolicy,
        }
      : defaultPolicy;
    const nextRefreshAt = earliestTemporaryAllowExpiresAt(grants, connectorRef);
    refreshes.push({
      connectorRef,
      networkPolicy: networkPolicyForFirewallPolicy(
        [...index.permissionNames],
        policy,
      ),
      nextRefreshAt: nextRefreshAt?.toISOString() ?? null,
    });
  }

  return refreshes;
}

export function networkPolicyRefreshesRecord(
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): Record<string, { readonly nextRefreshAt: string }> | undefined {
  const entries = refreshes.flatMap((refresh) => {
    if (refresh.nextRefreshAt === null) {
      return [];
    }
    return [
      [refresh.connectorRef, { nextRefreshAt: refresh.nextRefreshAt }] as const,
    ];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mergeNetworkPolicyRefreshes(
  networkPolicies: NetworkPolicies | undefined,
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): NetworkPolicies | undefined {
  if (!networkPolicies && refreshes.length === 0) {
    return undefined;
  }
  const merged: NetworkPolicies = { ...networkPolicies };
  for (const refresh of refreshes) {
    if (networkPolicies && !(refresh.connectorRef in networkPolicies)) {
      continue;
    }
    merged[refresh.connectorRef] = refresh.networkPolicy;
  }
  return merged;
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
  scope: { readonly agentId: string },
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

async function loadActiveNetworkPolicyRefreshRuns(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
): Promise<readonly ActiveNetworkPolicyRefreshRun[]> {
  return await db
    .select({
      runId: agentRuns.id,
      runnerGroup: agentRuns.runnerGroup,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .where(
      and(
        eq(agentRuns.orgId, scope.orgId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.status, "running"),
        isNotNull(agentRuns.runnerGroup),
        eq(agentComposeVersions.composeId, scope.agentId),
      ),
    );
}

async function publishActiveNetworkPolicyRefreshes(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  connectorRef: string,
): Promise<void> {
  const runs = await loadActiveNetworkPolicyRefreshRuns(db, scope);
  await Promise.all(
    runs.flatMap((run) => {
      if (!run.runnerGroup) {
        return [];
      }
      return publishNetworkPolicyRefreshToRunnerGroup(
        run.runnerGroup,
        run.runId,
        connectorRef,
      );
    }),
  );
}

function permissionGrantResponseScope(scope: UserPermissionGrantScope): {
  readonly agentId: string;
} {
  return { agentId: scope.agentId };
}

function applyPermissionGrantResponseScope(
  args: ApplyUserPermissionGrantsArgs,
): { readonly agentId: string } {
  return { agentId: requireAgentGrantApply(args.apply).agentId };
}

async function applyRowsAndPublishNetworkPolicyRefreshes(
  db: Db,
  args: ApplyUserPermissionGrantsArgs,
): Promise<readonly StoredPermissionGrantRow[] | NotFoundResponse> {
  const rows = await applyVisibleGrantRows(db, args);
  if ("status" in rows) {
    return rows;
  }

  const responseScope = applyPermissionGrantResponseScope(args);
  await publishActiveNetworkPolicyRefreshes(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      agentId: responseScope.agentId,
    },
    args.apply.connectorRef,
  );
  return rows;
}

export const listUserPermissionGrants$ = command(
  async (
    { get },
    scope: UserPermissionGrantScope,
    signal: AbortSignal,
  ): Promise<ListUserPermissionGrantsResult> => {
    const db = get(db$);
    const visibleError = await visibleAgentOrNotFound(db, {
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
    const rows = await applyRowsAndPublishNetworkPolicyRefreshes(writeDb, args);
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
