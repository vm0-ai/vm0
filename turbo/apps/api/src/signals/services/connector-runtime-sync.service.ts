import type {
  ConnectorRuntimeCustomAbsentReason,
  ConnectorRuntimeSyncResult,
  ConnectorRuntimeTarget,
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
import {
  CustomConnectorRuntimePrefixError,
  loadCustomConnectorRuntimeData,
} from "./zero-custom-connector.service";

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

function customAbsentResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomAbsentReason,
): ConnectorRuntimeResolution {
  return {
    result: {
      target,
      state: "absent",
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
          connectorRevision: userCustomConnectors.connectorRevision,
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
          grant:
            grant?.connectorRevision === row.connector.revision
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
  readonly target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>;
  readonly snapshot: Awaited<ReturnType<typeof loadCustomSnapshot>>;
}): Promise<ConnectorRuntimeResolution> {
  const custom = args.snapshot.customTargets.get(args.target.customConnectorId);
  if (!custom) {
    return customAbsentResult(args.target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "incompatible") {
    // Credential compatibility gates auth resolution, not definition-owned policy.
    L.debug("Custom connector credential storage is incompatible", {
      customConnectorId: args.target.customConnectorId,
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
  if (!custom.grant) {
    return customAbsentResult(args.target, "grant-unavailable");
  }
  const row = custom.row;
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row,
    snapshot: args.snapshot.connectorCatalogSnapshot,
  });
  if (permissionBundle === undefined) {
    return customAbsentResult(args.target, "permission-bundle-unavailable");
  }

  const contextResult = await settle(
    buildCustomConnectorRuntimeContext({
      rows: [row],
      featureSwitchContext: args.snapshot.featureSwitchContext,
      connectorCatalogSnapshot: args.snapshot.connectorCatalogSnapshot,
      grants: [custom.grant],
      preserveFirewallWithoutCredentials: true,
    }),
  );
  if (!contextResult.ok) {
    if (contextResult.error instanceof CustomConnectorRuntimePrefixError) {
      return customAbsentResult(
        args.target,
        "runtime-configuration-unavailable",
      );
    }
    throw contextResult.error;
  }
  const state = customConnectorRuntimeExecutionState({
    context: contextResult.value,
    connectorId: args.target.customConnectorId,
  });
  if (!state) {
    return customAbsentResult(args.target, "runtime-configuration-unavailable");
  }
  const result = {
    target: args.target,
    state: "available" as const,
    firewall: state.firewall,
    networkPolicy: state.networkPolicy,
  };
  return {
    result: {
      ...result,
      firewall: {
        ...state.firewall,
        customConnectorId: args.target.customConnectorId,
      },
    },
  };
}

export async function resolveConnectorRuntimeTargets(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTarget[];
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
  for (const target of args.targets) {
    if (target.kind === "custom") {
      if (!customSnapshot) {
        throw new Error("Custom connector runtime snapshot is unavailable");
      }
      results.push(
        await resolveCustomTarget({ target, snapshot: customSnapshot }),
      );
      continue;
    }
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
  return results;
}
