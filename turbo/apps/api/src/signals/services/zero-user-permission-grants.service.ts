import { command } from "ccstate";
import type { StoredConnectorPermissionBaseline } from "@vm0/api-contracts/contracts/runners";
import {
  createFirewallMetadataPolicyResolver,
  permissionGrantsToFirewallPolicies,
} from "@vm0/connectors/firewall-metadata/policy";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type FirewallPolicyValue,
  type NetworkPolicies,
  type NetworkPolicy,
} from "@vm0/connectors/firewall-types";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
} from "@vm0/db/schema/connector-catalog";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
import type {
  ApplyUserPermissionGrantsRequest,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { notFound } from "../../lib/error";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  publishConnectorPermissionUpdatedSafely,
  publishNetworkPolicyRefreshToRunnerGroup,
} from "../external/realtime";
import { nowDate } from "../external/time";
import {
  defaultFirewallPolicyForPermissionIndex,
  networkPolicyForFirewallPolicy,
} from "./firewall-network-policy.service";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import type { ConnectorServerFirewallCatalog } from "./connector-server-firewall-catalog.service";
import { connectorCatalogSource } from "./connector-catalog-source";
import { connectorCatalogExecutableCapabilityDigest } from "./connector-catalog-compatibility.service";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "./connector-catalog-artifacts/artifacts";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  currentConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

type UserPermissionGrantRow = typeof userPermissionGrants.$inferSelect;
type StoredPermissionGrantRow = UserPermissionGrantRow;
type ResolvedPermissionGrant = Pick<
  UserPermissionGrantRow,
  "connectorRef" | "permission" | "action" | "expiresAt"
>;
type UserPermissionGrantAction = UserPermissionGrantResponse["action"];

interface ActiveNetworkPolicyRefresh {
  readonly connectorSlug: string;
  readonly networkPolicy: NetworkPolicy;
  readonly nextRefreshAt: string | null;
}

interface ConnectorPermissionPolicyBaseline {
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
}

type BaselineNetworkPolicyRefreshResolution =
  | {
      readonly kind: "compatible";
      readonly refreshes: readonly ActiveNetworkPolicyRefresh[];
    }
  | {
      readonly kind: "empty";
      readonly refreshes: readonly ActiveNetworkPolicyRefresh[];
    }
  | { readonly kind: "incompatible" };

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

export function activeUserPermissionGrantCondition(
  checkedAt: Date,
): SQL | undefined {
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

function earliestTemporaryAllowExpiresAt(
  grants: readonly ResolvedPermissionGrant[],
  connectorSlug: string,
): Date | null {
  let earliest: Date | null = null;
  for (const grant of grants) {
    if (
      grant.connectorRef !== connectorSlug ||
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
  grants: readonly ResolvedPermissionGrant[],
): FirewallPolicies {
  return permissionGrantsToFirewallPolicies(grants) ?? {};
}

export function networkPolicyRefreshConnectorSlugs(
  catalog: ConnectorServerFirewallCatalog,
  connectorSlugs: readonly string[],
): string[] {
  return [
    ...new Set(
      connectorSlugs.filter((connectorSlug) => {
        return catalog.has(connectorSlug);
      }),
    ),
  ];
}

export async function resolveActiveNetworkPolicyRefreshes(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  connectorSlugs: readonly string[],
  preloadedSnapshot?: ConnectorRuntimeSnapshot,
  checkedAt: Date = nowDate(),
): Promise<readonly ActiveNetworkPolicyRefresh[]> {
  if (connectorSlugs.length === 0) {
    return [];
  }

  const snapshot =
    preloadedSnapshot ?? (await loadConnectorRuntimeSnapshot(db));
  const uniqueConnectorSlugs = networkPolicyRefreshConnectorSlugs(
    snapshot.serverFirewalls,
    connectorSlugs,
  );
  if (uniqueConnectorSlugs.length === 0) {
    return [];
  }

  const grants = await loadActiveUserPermissionGrantsForConnectorSlugs(
    db,
    scope,
    uniqueConnectorSlugs,
    checkedAt,
  );
  const indexes = await Promise.all(
    uniqueConnectorSlugs.map(async (connectorSlug) => {
      return {
        connectorSlug,
        index:
          await snapshot.serverFirewalls.loadPermissionIndex(connectorSlug),
      };
    }),
  );

  return activeNetworkPolicyRefreshesForPermissionBaselines(
    indexes.flatMap(({ connectorSlug, index }) => {
      return index
        ? [
            {
              connectorSlug,
              permissionNames: [...index.permissionNames],
              defaultPolicy: defaultFirewallPolicyForPermissionIndex(index),
            },
          ]
        : [];
    }),
    grants,
  );
}

function connectorCatalogIdentityJoin() {
  return and(
    eq(
      connectorCatalogCompatibilityEvaluation.sourceId,
      connectorCatalogActiveSnapshot.sourceId,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.schemaVersion,
      connectorCatalogActiveSnapshot.schemaVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogVersion,
      connectorCatalogActiveSnapshot.catalogVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogDigest,
      connectorCatalogActiveSnapshot.catalogDigest,
    ),
  );
}

function baselineStaticIdentityIsCurrent(
  baseline: StoredConnectorPermissionBaseline,
  current: {
    readonly sourceId: string;
    readonly capabilityDigest: string;
    readonly validator: ReturnType<
      typeof currentConnectorCatalogValidatorIdentity
    >;
  },
): boolean {
  return (
    baseline.catalogIdentity.sourceId === current.sourceId &&
    baseline.catalogIdentity.schemaVersion ===
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION &&
    baseline.catalogIdentity.capabilityDigest === current.capabilityDigest &&
    connectorCatalogValidationAuthorityIsCurrent({
      authority: baseline.validationAuthority,
      validator: current.validator,
    })
  );
}

function defaultFirewallPolicyForBaseline(
  baseline: StoredConnectorPermissionBaseline["connectors"][string],
): FirewallPolicy {
  const resolver = createFirewallMetadataPolicyResolver({
    defaultPolicy: baseline.defaultPolicy,
  });
  const policies: Record<string, FirewallPolicyValue> = {};
  for (const permissionName of baseline.permissionNames) {
    policies[permissionName] = resolver.permission(permissionName);
  }
  return {
    policies,
    unknownPolicy: resolver.unknown(),
  };
}

function activeNetworkPolicyRefreshesForPermissionBaselines(
  baselines: readonly ConnectorPermissionPolicyBaseline[],
  grants: readonly ResolvedPermissionGrant[],
): readonly ActiveNetworkPolicyRefresh[] {
  const policies = resolvedConnectorFirewallPolicies(grants);
  return baselines.map((baseline) => {
    const defaultPolicy = baseline.defaultPolicy;
    const connectorSlug = baseline.connectorSlug;
    const overlay = policies[connectorSlug];
    const policy: FirewallPolicy = overlay
      ? {
          policies: { ...defaultPolicy.policies, ...overlay.policies },
          unknownPolicy: overlay.unknownPolicy ?? defaultPolicy.unknownPolicy,
        }
      : defaultPolicy;
    const nextRefreshAt = earliestTemporaryAllowExpiresAt(
      grants,
      connectorSlug,
    );
    return {
      connectorSlug,
      networkPolicy: networkPolicyForFirewallPolicy(
        baseline.permissionNames,
        policy,
      ),
      nextRefreshAt: nextRefreshAt?.toISOString() ?? null,
    };
  });
}

export async function resolveActiveNetworkPolicyRefreshesFromBaseline(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  baseline: StoredConnectorPermissionBaseline,
  checkedAt: Date = nowDate(),
): Promise<BaselineNetworkPolicyRefreshResolution> {
  const connectorSlugs = Object.keys(baseline.connectors);
  if (connectorSlugs.length === 0) {
    return { kind: "empty", refreshes: [] };
  }
  const current = {
    sourceId: connectorCatalogSource().sourceId,
    capabilityDigest: connectorCatalogExecutableCapabilityDigest(),
    validator: currentConnectorCatalogValidatorIdentity(),
  };
  if (!baselineStaticIdentityIsCurrent(baseline, current)) {
    return { kind: "incompatible" };
  }

  const rows = await db
    .select({
      identity: {
        schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
        catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
        catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      },
      grant: {
        connectorRef: userPermissionGrants.connectorRef,
        permission: userPermissionGrants.permission,
        action: userPermissionGrants.action,
        expiresAt: userPermissionGrants.expiresAt,
      },
    })
    .from(connectorCatalogActiveSnapshot)
    .innerJoin(
      connectorCatalogCompatibilityEvaluation,
      connectorCatalogIdentityJoin(),
    )
    .leftJoin(
      userPermissionGrants,
      and(
        eq(userPermissionGrants.orgId, scope.orgId),
        eq(userPermissionGrants.userId, scope.userId),
        eq(userPermissionGrants.agentId, scope.agentId),
        inArray(userPermissionGrants.connectorRef, connectorSlugs),
        activeUserPermissionGrantCondition(checkedAt),
      ),
    )
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, current.sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          current.capabilityDigest,
        ),
      ),
    )
    .orderBy(
      asc(userPermissionGrants.connectorRef),
      asc(userPermissionGrants.permission),
    );

  const first = rows[0];
  if (
    first === undefined ||
    first.identity.schemaVersion !== baseline.catalogIdentity.schemaVersion ||
    first.identity.catalogVersion !== baseline.catalogIdentity.catalogVersion ||
    first.identity.catalogDigest !== baseline.catalogIdentity.catalogDigest
  ) {
    return { kind: "incompatible" };
  }

  const grants = rows.flatMap((row): readonly ResolvedPermissionGrant[] => {
    return row.grant === null ? [] : [row.grant];
  });
  return {
    kind: "compatible",
    refreshes: activeNetworkPolicyRefreshesForPermissionBaselines(
      Object.entries(baseline.connectors).map(([connectorSlug, entry]) => {
        return {
          connectorSlug,
          permissionNames: entry.permissionNames,
          defaultPolicy: defaultFirewallPolicyForBaseline(entry),
        };
      }),
      grants,
    ),
  };
}

export function networkPolicyRefreshesRecord(
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): Record<string, { readonly nextRefreshAt: string }> | undefined {
  const entries = refreshes.flatMap((refresh) => {
    if (refresh.nextRefreshAt === null) {
      return [];
    }
    return [
      [
        refresh.connectorSlug,
        { nextRefreshAt: refresh.nextRefreshAt },
      ] as const,
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
    if (
      networkPolicies &&
      !Object.hasOwn(networkPolicies, refresh.connectorSlug)
    ) {
      continue;
    }
    merged[refresh.connectorSlug] = refresh.networkPolicy;
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

async function loadActiveUserPermissionGrants(
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
        activeUserPermissionGrantCondition(checkedAt),
      ),
    )
    .orderBy(
      asc(userPermissionGrants.connectorRef),
      asc(userPermissionGrants.permission),
    );
}

async function loadActiveUserPermissionGrantsForConnectorSlugs(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  connectorSlugs: readonly string[],
  checkedAt: Date,
): Promise<readonly StoredPermissionGrantRow[]> {
  return await db
    .select()
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, scope.orgId),
        eq(userPermissionGrants.userId, scope.userId),
        eq(userPermissionGrants.agentId, scope.agentId),
        inArray(userPermissionGrants.connectorRef, connectorSlugs),
        activeUserPermissionGrantCondition(checkedAt),
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
  catalog: ConnectorServerFirewallCatalog,
): Promise<ValidationErrorResponse | null> {
  const index = await catalog.loadPermissionIndex(apply.connectorRef);
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
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        eq(agentRuns.orgId, scope.orgId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.status, "running"),
        isNotNull(agentRuns.runnerGroup),
        eq(agentSessions.agentComposeId, scope.agentId),
      ),
    );
}

async function publishActiveNetworkPolicyRefreshes(
  db: ReadonlyDb,
  scope: UserPermissionGrantScope,
  connectorSlug: string,
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
        connectorSlug,
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
  serverFirewalls: ConnectorServerFirewallCatalog,
): Promise<readonly StoredPermissionGrantRow[] | NotFoundResponse> {
  const rows = await applyVisibleGrantRows(db, args);
  if ("status" in rows) {
    return rows;
  }

  if (!serverFirewalls.has(args.apply.connectorRef)) {
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
    const writeDb = set(writeDb$);
    const snapshot = await loadConnectorRuntimeSnapshot(writeDb);
    signal.throwIfAborted();
    const validation = await validateApplyUserPermissionGrants(
      args.apply,
      snapshot.serverFirewalls,
    );
    signal.throwIfAborted();
    if (validation) {
      return validation;
    }

    const rows = await applyRowsAndPublishNetworkPolicyRefreshes(
      writeDb,
      args,
      snapshot.serverFirewalls,
    );
    signal.throwIfAborted();

    if ("status" in rows) {
      return rows;
    }
    await publishConnectorPermissionUpdatedSafely(args.userId);
    signal.throwIfAborted();
    const responseScope = applyPermissionGrantResponseScope(args);

    return {
      kind: "ok" as const,
      grants: rows.map((grant) => {
        return formatUserPermissionGrant(grant, responseScope);
      }),
    };
  },
);
