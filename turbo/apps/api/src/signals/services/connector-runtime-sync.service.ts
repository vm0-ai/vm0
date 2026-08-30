import {
  connectorRuntimeTargetKey,
  type ConnectorRuntimeCustomAbsentReason,
  type ConnectorRuntimeCustomUnresolvedReason,
  type ConnectorRuntimeSyncResult,
  type ConnectorRuntimeTarget,
  type ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { and, eq, inArray } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  buildCustomConnectorRuntimeContext,
  customConnectorRuntimeExecutionState,
  loadEffectiveCustomConnectorPermissionBundle,
  type CustomConnectorRuntimeDataRows,
} from "./agent-run-create.service";
import {
  loadConnectorRuntimeSelection,
  loadConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";
import { loadCustomConnectorRuntimeData } from "./custom-connector.service";
import {
  connectorAccountTargetKey,
  resolveConnectorAccounts,
  resolvedConnectorAccountIdsByTarget,
} from "./connector-account-resolution.service";
import { resolveConnectorCredentialAccess } from "./connector-credential-access.service";

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

function customAbsentResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomAbsentReason,
): ConnectorRuntimeSyncResult {
  return {
    target,
    state: "absent",
    reason,
  };
}

function customUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomUnresolvedReason,
): ConnectorRuntimeSyncResult {
  return {
    target,
    state: "unresolved",
    reason,
  };
}

function builtinUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "builtin" }>,
): ConnectorRuntimeSyncResult {
  return {
    target,
    state: "unresolved",
    reason: "connector-unavailable",
  };
}

async function loadCustomSnapshot(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly registrations: readonly Extract<
    ConnectorRuntimeTargetRegistration,
    { readonly kind: "custom" }
  >[];
}) {
  return await args.db.transaction(
    async (tx) => {
      const customConnectorIds = args.registrations.map((registration) => {
        return registration.customConnectorId;
      });
      const accountResolutions = await resolveConnectorAccounts(tx, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        requests: args.registrations.flatMap((registration) => {
          return registration.sourceId === undefined
            ? []
            : [
                {
                  target: {
                    kind: "custom" as const,
                    customConnectorId: registration.customConnectorId,
                  },
                  selection: {
                    kind: "exact" as const,
                    sourceId: registration.sourceId,
                  },
                },
              ];
        }),
      });
      const resolvedAccountIds =
        resolvedConnectorAccountIdsByTarget(accountResolutions);
      const memberConnectorIdsByCustomConnectorId = new Map<string, string>();
      for (const customConnectorId of customConnectorIds) {
        const memberConnectorId = resolvedAccountIds.get(
          connectorAccountTargetKey({ kind: "custom", customConnectorId }),
        );
        if (memberConnectorId) {
          memberConnectorIdsByCustomConnectorId.set(
            customConnectorId,
            memberConnectorId,
          );
        }
      }
      const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(tx);
      const featureSwitchContext = await loadUserFeatureSwitchContext(
        tx,
        args.scope.orgId,
        args.scope.userId,
      );
      const runtimeRows = await loadCustomConnectorRuntimeData(tx, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        connectorIds: customConnectorIds,
        memberConnectorIdsByCustomConnectorId,
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
            inArray(userCustomConnectors.customConnectorId, customConnectorIds),
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
        accountResolutions,
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
}): Promise<ConnectorRuntimeSyncResult> {
  const target = {
    kind: "custom" as const,
    customConnectorId: args.registration.customConnectorId,
  };
  const accountResolution = args.snapshot.accountResolutions.get(
    connectorAccountTargetKey(target),
  );
  if (accountResolution?.kind !== "resolved") {
    return customAbsentResult(target, "connector-unavailable");
  }
  const custom = args.snapshot.customTargets.get(target.customConnectorId);
  if (!custom) {
    return customAbsentResult(target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "incompatible") {
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
    return customAbsentResult(target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "absent") {
    return customAbsentResult(target, "connector-unavailable");
  }
  const row = custom.row;
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row,
    snapshot: args.snapshot.connectorCatalogSnapshot,
  });
  if (permissionBundle === undefined) {
    return customUnresolvedResult(target, "permission-bundle-unavailable");
  }

  const baseUrlVarsByConnectorId = new Map([
    [target.customConnectorId, args.registration.baseUrlVars] as const,
  ]);

  const context = await buildCustomConnectorRuntimeContext({
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
  });
  const state = customConnectorRuntimeExecutionState({
    context,
    connectorId: target.customConnectorId,
  });
  const resolvedTarget = context.targets.find((candidate) => {
    return (
      candidate.kind === "custom" &&
      candidate.customConnectorId === target.customConnectorId
    );
  });
  if (!state || resolvedTarget?.kind !== "custom") {
    return customUnresolvedResult(target, "runtime-configuration-unavailable");
  }
  return {
    target,
    state: "available" as const,
    firewall: {
      ...state.firewall,
      sourceId: accountResolution.account.connectorId,
    },
    networkPolicy: state.networkPolicy,
    baseUrlVars: { ...resolvedTarget.baseUrlVars },
  };
}

export async function resolveConnectorRuntimeTargets(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}): Promise<readonly ConnectorRuntimeSyncResult[]> {
  const builtinConnectorSlugs = args.targets.flatMap((target) => {
    return target.kind === "builtin" ? [target.connectorSlug] : [];
  });
  const customRegistrations = args.targets.flatMap((target) => {
    return target.kind === "custom" ? [target] : [];
  });
  const builtinCatalogSelection =
    builtinConnectorSlugs.length > 0
      ? await loadConnectorRuntimeSelection(args.db, {
          requestedConnectorSlugs: builtinConnectorSlugs,
        })
      : undefined;
  const [builtinRefreshes, builtinAccountResolutions, customSnapshot] =
    await Promise.all([
      resolveActiveNetworkPolicyRefreshes(
        args.db,
        args.scope,
        builtinConnectorSlugs,
        builtinCatalogSelection,
      ),
      resolveConnectorAccounts(args.db, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        requests: args.targets.flatMap((registration) => {
          return registration.kind === "builtin" &&
            registration.sourceId !== undefined
            ? [
                {
                  target: {
                    kind: "builtin" as const,
                    connectorSlug: registration.connectorSlug,
                  },
                  selection: {
                    kind: "exact" as const,
                    sourceId: registration.sourceId,
                  },
                },
              ]
            : [];
        }),
      }),
      customRegistrations.length > 0
        ? loadCustomSnapshot({
            db: args.db,
            scope: args.scope,
            registrations: customRegistrations,
          })
        : undefined,
    ]);
  const builtinByTarget = new Map(
    builtinRefreshes.map((refresh) => {
      return [
        connectorRuntimeTargetKey({
          kind: "builtin",
          connectorSlug: refresh.connectorSlug,
        }),
        refresh,
      ] as const;
    }),
  );

  const results: ConnectorRuntimeSyncResult[] = [];
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
    const accountResolution = builtinAccountResolutions.get(
      connectorAccountTargetKey(target),
    );
    const credentialAccess =
      accountResolution?.kind === "resolved" && builtinCatalogSelection
        ? resolveConnectorCredentialAccess({
            snapshot: builtinCatalogSelection,
            stored: {
              authMethodId: accountResolution.account.authMethod,
              connectorId: accountResolution.account.connectorId,
              connectorSlug: registration.connectorSlug,
              orgId: args.scope.orgId,
              storageVersion: accountResolution.account.storageVersion,
              userId: args.scope.userId,
            },
          })
        : undefined;
    const refresh = builtinByTarget.get(connectorRuntimeTargetKey(target));
    results.push(
      refresh && credentialAccess?.kind === "ok"
        ? {
            target,
            state: "available",
            networkPolicy: refresh.networkPolicy,
            ...(refresh.nextRefreshAt
              ? { nextSyncAt: refresh.nextRefreshAt }
              : {}),
          }
        : builtinUnresolvedResult(target),
    );
  }
  const stateCounts = { available: 0, absent: 0, unresolved: 0 };
  for (const result of results) {
    stateCounts[result.state] += 1;
  }
  L.debug("Resolved connector runtime targets", {
    targetCount: args.targets.length,
    builtinTargetCount: builtinConnectorSlugs.length,
    customTargetCount: customRegistrations.length,
    availableCount: stateCounts.available,
    absentCount: stateCounts.absent,
    unresolvedCount: stateCounts.unresolved,
  });
  return results;
}
