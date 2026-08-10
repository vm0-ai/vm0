import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@vm0/db/schema/org-custom-connector-oauth-config";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { isCustomConnectorMcpEnabled } from "./custom-connector-mcp-feature.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import { publishConnectorRuntimeSyncWakeups } from "./connector-runtime-wakeup.service";
import {
  effectiveCustomConnectorPermissionBundleRef,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
} from "./feishu-custom-connector-permissions";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { Tx } from "../../lib/db-types";

type UpdateUserConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    }
  | { readonly status: "agentNotFound" };

type UserConnectorUpdateOperation = "replace" | "add" | "remove";

type UpdateUserCustomConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledIds: readonly string[];
      readonly grants: readonly AgentCustomConnectorGrant[];
    }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    }
  | { readonly status: "mcpFeatureDisabled" };

type UserCustomConnectorUpdateOperation = "replace" | "add" | "remove";
type DbTransaction = Tx;

interface UserCustomConnectorTransactionResult {
  readonly result: UpdateUserCustomConnectorsResult;
  readonly previousIds: readonly string[];
}

interface UpdateUserCustomConnectorsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly enabledIds: readonly string[];
  readonly grants?: readonly AgentCustomConnectorGrant[];
  readonly operation?: UserCustomConnectorUpdateOperation;
}

interface UpdateUserCustomConnectorsOptions {
  readonly deferRuntimeWakeupUntilOuterCommit?: boolean;
}

type AddUserCustomConnectorResult =
  | { readonly status: "added" }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    }
  | { readonly status: "mcpFeatureDisabled" };

async function lockAgentComposeForConnectorReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.agentId),
      ),
    )
    .for("update")
    .limit(1);
  return compose !== undefined;
}

async function lockZeroAgentForConnectorReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        eq(zeroAgents.id, args.agentId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
      ),
    )
    .for("update")
    .limit(1);
  return agent !== undefined;
}

export async function lockUserCustomConnectorGrantScope(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  return (
    (await lockAgentComposeForConnectorReplace(db, args)) &&
    (await lockZeroAgentForConnectorReplace(db, args))
  );
}

interface LockedCustomConnectorRow {
  readonly id: string;
  readonly slug: string;
  readonly prefixTemplates: readonly string[];
  readonly mcpTransport: string | null;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly oauthProviderAdapter: string | null;
  readonly permissionBundleRef: string | null;
}

interface LockedCustomConnectorDefinitions {
  readonly missingIds: readonly string[];
  readonly mcpConnectorIds: ReadonlySet<string>;
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
}

async function lockCustomConnectorDefinitionsForGrant(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly enabledIds: readonly string[];
  },
): Promise<LockedCustomConnectorDefinitions> {
  if (args.enabledIds.length === 0) {
    return {
      missingIds: [],
      mcpConnectorIds: new Set(),
      permissionBundleRefs: new Map(),
    };
  }

  const sortedIds = [...args.enabledIds].sort();
  const lockedRows: LockedCustomConnectorRow[] = [];
  for (const id of sortedIds) {
    const [locked] = await db
      .select({
        id: orgCustomConnectors.id,
        slug: orgCustomConnectors.slug,
        prefixTemplates: orgCustomConnectors.prefixTemplates,
        mcpTransport: orgCustomConnectors.mcpTransport,
        authMode: orgCustomConnectors.authMode,
        oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
        permissionBundleRef: orgCustomConnectors.permissionBundleRef,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.id, id),
          eq(orgCustomConnectors.enabled, true),
        ),
      )
      .for("update", { of: orgCustomConnectors })
      .limit(1);
    if (locked) {
      lockedRows.push(locked);
    }
  }

  const lockedIds = new Set(
    lockedRows.map((row) => {
      return row.id;
    }),
  );
  const mcpConnectorIds = new Set(
    lockedRows.flatMap((row) => {
      return row.mcpTransport === null ? [] : [row.id];
    }),
  );
  const missingIds = args.enabledIds.filter((id) => {
    return !lockedIds.has(id);
  });
  if (missingIds.length > 0) {
    return {
      missingIds,
      mcpConnectorIds,
      permissionBundleRefs: new Map(),
    };
  }

  return {
    missingIds: [],
    mcpConnectorIds,
    permissionBundleRefs: new Map(
      lockedRows.map((row) => {
        return [
          row.id,
          effectiveCustomConnectorPermissionBundleRef({
            slug: row.slug,
            authMode: row.authMode,
            oauthProviderAdapter: row.oauthProviderAdapter,
            prefixTemplates: row.prefixTemplates,
            permissionBundleRef: row.permissionBundleRef,
          }),
        ] as const;
      }),
    ),
  };
}

export async function updateUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    readonly operation?: UserConnectorUpdateOperation;
    readonly allowMissingZeroAgentForEmptyReplace: boolean;
  },
): Promise<UpdateUserConnectorsResult> {
  const enabledConnectorSlugs = Array.from(new Set(args.enabledConnectorSlugs));
  const operation = args.operation ?? "replace";

  return await db.transaction(async (tx) => {
    const composeLocked = await lockAgentComposeForConnectorReplace(tx, args);
    if (!composeLocked) {
      return { status: "agentNotFound" };
    }

    const agentLocked = await lockZeroAgentForConnectorReplace(tx, args);
    if (
      !agentLocked &&
      (enabledConnectorSlugs.length > 0 ||
        !args.allowMissingZeroAgentForEmptyReplace)
    ) {
      return { status: "agentNotFound" };
    }

    const connectorScope = and(
      eq(userConnectors.orgId, args.orgId),
      eq(userConnectors.userId, args.userId),
      eq(userConnectors.agentId, args.agentId),
    );

    if (operation === "replace") {
      await tx.delete(userConnectors).where(connectorScope);
    } else if (operation === "remove" && enabledConnectorSlugs.length > 0) {
      await tx
        .delete(userConnectors)
        .where(
          and(
            connectorScope,
            inArray(userConnectors.connectorSlug, enabledConnectorSlugs),
          ),
        );
    }

    if (operation !== "remove" && enabledConnectorSlugs.length > 0) {
      await tx
        .insert(userConnectors)
        .values(
          enabledConnectorSlugs.map((connectorSlug) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              connectorSlug,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (operation === "replace") {
      return { status: "updated", enabledConnectorSlugs };
    }

    const rows = await tx
      .select({ connectorSlug: userConnectors.connectorSlug })
      .from(userConnectors)
      .where(connectorScope);
    return {
      status: "updated",
      enabledConnectorSlugs: rows.map((row) => {
        return row.connectorSlug;
      }),
    };
  });
}

interface NormalizedCustomConnectorGrantRequest {
  readonly enabledIds: readonly string[];
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
}

type InvalidCustomConnectorPermissionsResult = Extract<
  UpdateUserCustomConnectorsResult,
  { readonly status: "invalidCustomConnectorPermissions" }
>;

type PermissionSelectionError = Extract<
  UpdateUserCustomConnectorsResult,
  {
    readonly status:
      | "invalidCustomConnectorPermissions"
      | "customConnectorPermissionSelectionRequired";
  }
>;

function normalizeCustomConnectorGrantRequest(args: {
  readonly enabledIds: readonly string[];
  readonly grants?: readonly AgentCustomConnectorGrant[];
}):
  | NormalizedCustomConnectorGrantRequest
  | InvalidCustomConnectorPermissionsResult {
  const grantByConnectorId = new Map<string, readonly string[]>();
  for (const grant of args.grants ?? []) {
    if (grantByConnectorId.has(grant.customConnectorId)) {
      return {
        status: "invalidCustomConnectorPermissions",
        message: `Duplicate custom connector grant: ${grant.customConnectorId}`,
      };
    }
    const uniquePermissionNames = new Set(grant.permissionNames);
    if (uniquePermissionNames.size !== grant.permissionNames.length) {
      return {
        status: "invalidCustomConnectorPermissions",
        message: `Duplicate permission names for custom connector ${grant.customConnectorId}`,
      };
    }
    grantByConnectorId.set(grant.customConnectorId, [...uniquePermissionNames]);
  }
  const enabledIds =
    args.grants !== undefined
      ? [...grantByConnectorId.keys()]
      : Array.from(new Set(args.enabledIds));
  return { enabledIds, grantByConnectorId };
}

async function validateExplicitPermissionNames(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorId: string;
  readonly permissionNames: readonly string[];
  readonly permissionBundleRef: string | null;
}): Promise<
  | { readonly ok: true; readonly permissionNames: readonly string[] }
  | {
      readonly ok: false;
      readonly error: InvalidCustomConnectorPermissionsResult;
    }
> {
  if (args.permissionBundleRef === null) {
    return args.permissionNames.length === 0
      ? { ok: true, permissionNames: [] }
      : {
          ok: false,
          error: {
            status: "invalidCustomConnectorPermissions",
            message: `Custom connector ${args.connectorId} has no permission bundle`,
          },
        };
  }

  const bundle = await loadCustomConnectorPermissionBundle({
    snapshot: args.snapshot,
    ref: args.permissionBundleRef,
  });
  if (!bundle) {
    return {
      ok: false,
      error: {
        status: "invalidCustomConnectorPermissions",
        message: `Permission bundle is unavailable for custom connector ${args.connectorId}`,
      },
    };
  }
  const invalidPermissionNames = args.permissionNames.filter(
    (permissionName) => {
      return !bundle.permissionNames.has(permissionName);
    },
  );
  return invalidPermissionNames.length === 0
    ? { ok: true, permissionNames: [...args.permissionNames] }
    : {
        ok: false,
        error: {
          status: "invalidCustomConnectorPermissions",
          message: `Unknown permission names for custom connector ${args.connectorId}: ${invalidPermissionNames.join(", ")}`,
        },
      };
}

async function validateCustomConnectorPermissionSelection(args: {
  readonly enabledIds: readonly string[];
  readonly explicitGrants: boolean;
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
  readonly snapshot: ConnectorRuntimeSnapshot | null;
}): Promise<
  | {
      readonly ok: true;
      readonly permissionNamesByConnectorId: ReadonlyMap<
        string,
        readonly string[]
      >;
    }
  | { readonly ok: false; readonly error: PermissionSelectionError }
> {
  if (!args.explicitGrants) {
    const connectorIds = args.enabledIds.filter((connectorId) => {
      const permissionBundleRef =
        args.permissionBundleRefs.get(connectorId) ?? null;
      return (
        permissionBundleRef !== null &&
        permissionBundleRef !== FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF
      );
    });
    return connectorIds.length === 0
      ? {
          ok: true,
          permissionNamesByConnectorId: new Map(
            args.enabledIds.map((connectorId) => {
              return [connectorId, []] as const;
            }),
          ),
        }
      : {
          ok: false,
          error: {
            status: "customConnectorPermissionSelectionRequired",
            connectorIds,
          },
        };
  }
  if (!args.snapshot) {
    throw new Error("Expected connector catalog snapshot");
  }

  const permissionNamesByConnectorId = new Map<string, readonly string[]>();
  for (const connectorId of args.enabledIds) {
    const result = await validateExplicitPermissionNames({
      snapshot: args.snapshot,
      connectorId,
      permissionNames: args.grantByConnectorId.get(connectorId) ?? [],
      permissionBundleRef: args.permissionBundleRefs.get(connectorId) ?? null,
    });
    if (!result.ok) {
      return result;
    }
    permissionNamesByConnectorId.set(connectorId, result.permissionNames);
  }
  return { ok: true, permissionNamesByConnectorId };
}

async function persistUserCustomConnectorUpdate(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledIds: readonly string[];
    readonly operation: UserCustomConnectorUpdateOperation;
    readonly permissionNamesByConnectorId: ReadonlyMap<
      string,
      readonly string[]
    >;
  },
): Promise<Extract<UpdateUserCustomConnectorsResult, { status: "updated" }>> {
  const connectorScope = and(
    eq(userCustomConnectors.orgId, args.orgId),
    eq(userCustomConnectors.userId, args.userId),
    eq(userCustomConnectors.agentId, args.agentId),
  );
  if (args.operation === "replace") {
    await tx.delete(userCustomConnectors).where(connectorScope);
  } else if (args.operation === "remove" && args.enabledIds.length > 0) {
    await tx
      .delete(userCustomConnectors)
      .where(
        and(
          connectorScope,
          inArray(userCustomConnectors.customConnectorId, args.enabledIds),
        ),
      );
  }

  if (args.operation !== "remove" && args.enabledIds.length > 0) {
    await tx
      .insert(userCustomConnectors)
      .values(
        args.enabledIds.map((customConnectorId) => {
          return {
            orgId: args.orgId,
            userId: args.userId,
            agentId: args.agentId,
            customConnectorId,
            permissionNames: [
              ...(args.permissionNamesByConnectorId.get(customConnectorId) ??
                []),
            ],
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          userCustomConnectors.orgId,
          userCustomConnectors.userId,
          userCustomConnectors.agentId,
          userCustomConnectors.customConnectorId,
        ],
        set: {
          permissionNames: sql`excluded.permission_names`,
        },
      });
  }

  if (args.operation === "replace") {
    return {
      status: "updated",
      enabledIds: args.enabledIds,
      grants: args.enabledIds.map((customConnectorId) => {
        return {
          customConnectorId,
          permissionNames: [
            ...(args.permissionNamesByConnectorId.get(customConnectorId) ?? []),
          ],
        };
      }),
    };
  }
  const rows = await tx
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(and(connectorScope, eq(orgCustomConnectors.enabled, true)))
    .orderBy(userCustomConnectors.customConnectorId);
  return {
    status: "updated",
    enabledIds: rows.map((row) => {
      return row.customConnectorId;
    }),
    grants: rows.map((row) => {
      return {
        customConnectorId: row.customConnectorId,
        permissionNames: [...row.permissionNames],
      };
    }),
  };
}

async function persistUserCustomConnectorTransaction(args: {
  readonly tx: DbTransaction;
  readonly request: UpdateUserCustomConnectorsArgs;
  readonly enabledIds: readonly string[];
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
  readonly operation: UserCustomConnectorUpdateOperation;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot | null;
}): Promise<UserCustomConnectorTransactionResult> {
  const agentLocked = await lockUserCustomConnectorGrantScope(
    args.tx,
    args.request,
  );
  if (!agentLocked) {
    return { result: { status: "agentNotFound" }, previousIds: [] };
  }
  const previousRows = await args.tx
    .select({ customConnectorId: userCustomConnectors.customConnectorId })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.request.orgId),
        eq(userCustomConnectors.userId, args.request.userId),
        eq(userCustomConnectors.agentId, args.request.agentId),
      ),
    )
    .for("update");
  const previousIds = previousRows.map((row) => {
    return row.customConnectorId;
  });

  if (args.operation === "remove") {
    return {
      result: await persistUserCustomConnectorUpdate(args.tx, {
        ...args.request,
        enabledIds: args.enabledIds,
        operation: args.operation,
        permissionNamesByConnectorId: new Map(),
      }),
      previousIds,
    };
  }
  const definitions = await lockCustomConnectorDefinitionsForGrant(args.tx, {
    orgId: args.request.orgId,
    enabledIds: args.enabledIds,
  });
  if (definitions.missingIds.length > 0) {
    return {
      result: {
        status: "customConnectorsNotFound",
        missingIds: definitions.missingIds,
      },
      previousIds,
    };
  }
  const previousIdSet = new Set(previousIds);
  const addsMcpConnector = args.enabledIds.some((connectorId) => {
    return (
      !previousIdSet.has(connectorId) &&
      definitions.mcpConnectorIds.has(connectorId)
    );
  });
  if (addsMcpConnector) {
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      args.tx,
      args.request.orgId,
      args.request.userId,
    );
    if (!isCustomConnectorMcpEnabled(featureSwitchContext)) {
      return {
        result: { status: "mcpFeatureDisabled" },
        previousIds,
      };
    }
  }
  const permissionSelection = await validateCustomConnectorPermissionSelection({
    enabledIds: args.enabledIds,
    explicitGrants: args.request.grants !== undefined,
    grantByConnectorId: args.grantByConnectorId,
    permissionBundleRefs: definitions.permissionBundleRefs,
    snapshot: args.connectorCatalogSnapshot,
  });
  if (!permissionSelection.ok) {
    return { result: permissionSelection.error, previousIds };
  }
  return {
    result: await persistUserCustomConnectorUpdate(args.tx, {
      ...args.request,
      enabledIds: args.enabledIds,
      operation: args.operation,
      permissionNamesByConnectorId:
        permissionSelection.permissionNamesByConnectorId,
    }),
    previousIds,
  };
}

export async function updateUserCustomConnectors(
  db: Db,
  args: UpdateUserCustomConnectorsArgs,
  options: UpdateUserCustomConnectorsOptions = {},
): Promise<UpdateUserCustomConnectorsResult> {
  const normalized = normalizeCustomConnectorGrantRequest(args);
  if ("status" in normalized) {
    return normalized;
  }
  const { enabledIds, grantByConnectorId } = normalized;
  const operation = args.operation ?? "replace";
  const connectorCatalogSnapshot =
    args.grants !== undefined && operation !== "remove"
      ? await loadConnectorRuntimeSnapshot(db)
      : null;

  const committed = await db.transaction(async (tx) => {
    return await persistUserCustomConnectorTransaction({
      tx,
      request: args,
      enabledIds,
      grantByConnectorId,
      operation,
      connectorCatalogSnapshot,
    });
  });
  if (
    committed.result.status === "updated" &&
    !options.deferRuntimeWakeupUntilOuterCommit
  ) {
    await publishConnectorRuntimeSyncWakeups({
      db,
      scope: {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
      },
      targets: [
        ...committed.previousIds,
        ...committed.result.enabledIds,
        ...enabledIds,
      ].map((customConnectorId) => {
        return { kind: "custom" as const, customConnectorId };
      }),
    });
  }
  return committed.result;
}

export async function addUserCustomConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly customConnectorId: string;
  },
  options: UpdateUserCustomConnectorsOptions = {},
): Promise<AddUserCustomConnectorResult> {
  const result = await updateUserCustomConnectors(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      enabledIds: [args.customConnectorId],
      operation: "add",
    },
    options,
  );
  if (result.status === "updated") {
    return { status: "added" };
  }
  return result;
}
