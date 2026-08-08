import type {
  ConnectorRuntimeCustomUnavailableReason,
  ConnectorRuntimeSyncResult,
  ConnectorRuntimeTarget,
  ConnectorRuntimeTargetRegistration,
} from "@vm0/api-contracts/contracts/runners";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { and, eq, inArray } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  buildCustomConnectorRuntimeContext,
  customConnectorRuntimeExecutionState,
  loadEffectiveCustomConnectorPermissionBundle,
  type CustomConnectorRuntimeDataRows,
} from "./agent-run-create.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveActiveNetworkPolicyRefreshes } from "./zero-user-permission-grants.service";
import { loadCustomConnectorRuntimeData } from "./zero-custom-connector.service";

const L = logger("connector-runtime-sync");

interface ConnectorRuntimeScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface CustomTargetSnapshot {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly grant: AgentCustomConnectorGrant | undefined;
}

interface ConnectorRuntimeResolution {
  readonly result: ConnectorRuntimeSyncResult;
}

function connectorRuntimeTargetIdentity(
  registration: ConnectorRuntimeTargetRegistration,
): ConnectorRuntimeTarget {
  return registration.kind === "builtin"
    ? {
        kind: "builtin",
        connectorSlug: registration.connectorSlug,
      }
    : {
        kind: "custom",
        customConnectorId: registration.customConnectorId,
      };
}

function customAbsentResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomUnavailableReason,
): ConnectorRuntimeResolution {
  return {
    result: {
      target,
      state: "absent",
      reason,
    },
  };
}

function customUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomUnavailableReason,
): ConnectorRuntimeResolution {
  return {
    result: {
      target,
      state: "unresolved",
      reason,
    },
  };
}

function builtinUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "builtin" }>,
): ConnectorRuntimeResolution {
  return {
    result: {
      target,
      state: "unresolved",
      reason: "connector-unavailable",
    },
  };
}

async function loadCustomSnapshot(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly customConnectorIds: readonly string[];
}) {
  return await args.db.transaction(
    async (tx) => {
      const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(tx);
      const featureSwitchContext = await loadUserFeatureSwitchContext(
        tx,
        args.scope.orgId,
        args.scope.userId,
      );
      const runtimeRows = await loadCustomConnectorRuntimeData(tx, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        connectorIds: args.customConnectorIds,
      });
      const grantRows = await tx
        .select({
          customConnectorId: userCustomConnectors.customConnectorId,
          permissionNames: userCustomConnectors.permissionNames,
        })
        .from(userCustomConnectors)
        .where(
          and(
            eq(userCustomConnectors.orgId, args.scope.orgId),
            eq(userCustomConnectors.userId, args.scope.userId),
            eq(userCustomConnectors.agentId, args.scope.agentId),
            inArray(
              userCustomConnectors.customConnectorId,
              args.customConnectorIds,
            ),
          ),
        );
      const grants = new Map(
        grantRows.map((grant) => {
          return [grant.customConnectorId, grant] as const;
        }),
      );
      const customTargets = new Map<string, CustomTargetSnapshot>();
      for (const row of runtimeRows) {
        const grant = grants.get(row.connector.id);
        customTargets.set(row.connector.id, {
          row,
          grant: grant
            ? {
                customConnectorId: grant.customConnectorId,
                permissionNames: [...grant.permissionNames],
              }
            : undefined,
        });
      }
      return {
        connectorCatalogSnapshot,
        featureSwitchContext,
        customTargets,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function resolveCustomTarget(args: {
  readonly registration: Extract<
    ConnectorRuntimeTargetRegistration,
    { readonly kind: "custom" }
  >;
  readonly snapshot: Awaited<ReturnType<typeof loadCustomSnapshot>>;
}): Promise<ConnectorRuntimeResolution> {
  const target = connectorRuntimeTargetIdentity(args.registration);
  if (target.kind !== "custom") {
    throw new Error("Expected Custom connector runtime target");
  }
  const custom = args.snapshot.customTargets.get(target.customConnectorId);
  if (!custom) {
    return customAbsentResult(target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "incompatible") {
    // Credential compatibility gates auth resolution, not definition-owned policy.
    L.debug("Custom connector credential storage is incompatible", {
      customConnectorId: target.customConnectorId,
      memberConnectorId: custom.row.credentialAccess.memberConnectorId,
      expectedAuthMethod: custom.row.credentialAccess.expectedAuthMethod,
      storedAuthMethod: custom.row.credentialAccess.storedAuthMethod,
      expectedStorageVersion:
        custom.row.credentialAccess.expectedStorageVersion,
      storedStorageVersion: custom.row.credentialAccess.storedStorageVersion,
      definitionAuthMethod: custom.row.credentialAccess.definitionAuthMethod,
      definitionStorageVersion:
        custom.row.credentialAccess.definitionStorageVersion,
    });
  }
  const row = custom.row;
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row,
    snapshot: args.snapshot.connectorCatalogSnapshot,
  });
  if (permissionBundle === undefined) {
    return customUnresolvedResult(target, "permission-bundle-unavailable");
  }

  const baseUrlVarsByConnectorId =
    args.registration.baseUrlVars === undefined
      ? undefined
      : new Map([
          [target.customConnectorId, args.registration.baseUrlVars] as const,
        ]);

  const contextResult = await settle(
    buildCustomConnectorRuntimeContext({
      rows: [row],
      featureSwitchContext: args.snapshot.featureSwitchContext,
      connectorCatalogSnapshot: args.snapshot.connectorCatalogSnapshot,
      grants: [
        custom.grant ?? {
          customConnectorId: target.customConnectorId,
          permissionNames: [],
        },
      ],
      baseUrlVarsByConnectorId,
    }),
  );
  if (!contextResult.ok) {
    throw contextResult.error;
  }
  const state = customConnectorRuntimeExecutionState({
    context: contextResult.value,
    connectorId: target.customConnectorId,
  });
  const resolvedTarget = contextResult.value.targets.find((candidate) => {
    return (
      candidate.kind === "custom" &&
      candidate.customConnectorId === target.customConnectorId
    );
  });
  if (
    !state ||
    resolvedTarget?.kind !== "custom" ||
    resolvedTarget.baseUrlVars === undefined
  ) {
    return customUnresolvedResult(target, "runtime-configuration-unavailable");
  }
  const result = {
    target,
    state: "available" as const,
    firewall: state.firewall,
    networkPolicy: state.networkPolicy,
    baseUrlVars: { ...resolvedTarget.baseUrlVars },
  };
  return { result };
}

export async function resolveConnectorRuntimeTargets(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}): Promise<readonly ConnectorRuntimeResolution[]> {
  const builtinConnectorSlugs = args.targets.flatMap((target) => {
    return target.kind === "builtin" ? [target.connectorSlug] : [];
  });
  const customConnectorIds = args.targets.flatMap((target) => {
    return target.kind === "custom" ? [target.customConnectorId] : [];
  });
  const [builtinRefreshes, customSnapshot] = await Promise.all([
    resolveActiveNetworkPolicyRefreshes(
      args.db,
      args.scope,
      builtinConnectorSlugs,
    ),
    customConnectorIds.length > 0
      ? loadCustomSnapshot({
          db: args.db,
          scope: args.scope,
          customConnectorIds,
        })
      : undefined,
  ]);
  const builtinByTarget = new Map(
    builtinRefreshes.map((refresh) => {
      return [`builtin:${refresh.connectorSlug}`, refresh] as const;
    }),
  );

  const results: ConnectorRuntimeResolution[] = [];
  for (const registration of args.targets) {
    if (registration.kind === "custom") {
      if (!customSnapshot) {
        throw new Error("Custom connector runtime snapshot is unavailable");
      }
      results.push(
        await resolveCustomTarget({ registration, snapshot: customSnapshot }),
      );
      continue;
    }
    const target = {
      kind: "builtin" as const,
      connectorSlug: registration.connectorSlug,
    };
    const refresh = builtinByTarget.get(`builtin:${target.connectorSlug}`);
    results.push(
      refresh
        ? {
            result: {
              target,
              state: "available",
              networkPolicy: refresh.networkPolicy,
              ...(refresh.nextRefreshAt
                ? { nextSyncAt: refresh.nextRefreshAt }
                : {}),
            },
          }
        : builtinUnresolvedResult(target),
    );
  }
  const stateCounts = { available: 0, absent: 0, unresolved: 0 };
  for (const resolution of results) {
    stateCounts[resolution.result.state] += 1;
  }
  L.debug("Resolved connector runtime targets", {
    targetCount: args.targets.length,
    builtinTargetCount: builtinConnectorSlugs.length,
    customTargetCount: customConnectorIds.length,
    customPinnedTargetCount: args.targets.filter((target) => {
      return target.kind === "custom" && target.baseUrlVars !== undefined;
    }).length,
    availableCount: stateCounts.available,
    absentCount: stateCounts.absent,
    unresolvedCount: stateCounts.unresolved,
  });
  return results;
}
