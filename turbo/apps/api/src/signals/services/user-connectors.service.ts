import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { userCustomConnectorsInsertTarget } from "@vm0/db/custom-connector-insert-targets";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  orgCustomConnectors,
  type OrgCustomConnectorField,
  type OrgCustomConnectorAuthMode,
  type OrgCustomConnectorHeaderInjection,
  type OrgCustomConnectorQueryInjection,
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
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import { publishCustomConnectorRuntimeSyncWakeups } from "./custom-connector-runtime-wakeup.service";
import {
  loadCurrentCustomConnectorOAuthConnectionIds,
  loadCurrentCustomConnectorValueMarkers,
} from "./custom-connector-credential-access.service";
import {
  effectiveCustomConnectorPermissionBundleRef,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
} from "./feishu-custom-connector-permissions";
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
      readonly status: "customConnectorsNotConfigured";
      readonly unconfiguredIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    };

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
      readonly status: "customConnectorsNotConfigured";
      readonly unconfiguredIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    };

const LEGACY_SECRET_KEY = "secret";
const LEGACY_SECRET_PLACEHOLDER = "{{secret}}";
const CUSTOM_CONNECTOR_TEMPLATE_REFERENCE_REGEX =
  /\{\{\s*(secrets|variables|oauth)\.([a-z][a-z0-9_]*)\s*\}\}/g;

function legacyCustomConnectorFields(): readonly OrgCustomConnectorField[] {
  return [
    {
      key: LEGACY_SECRET_KEY,
      label: "Secret",
      kind: "secret",
      required: true,
      description: "API credential",
    },
  ];
}

function customConnectorGrantFields(
  fields: readonly OrgCustomConnectorField[],
): readonly OrgCustomConnectorField[] {
  return fields.length > 0 ? fields : legacyCustomConnectorFields();
}

function customConnectorValueMarkerKey(marker: {
  readonly kind: "secret" | "variable";
  readonly key: string;
}): string {
  return `${marker.kind}:${marker.key}`;
}

function customConnectorFieldConfigured(args: {
  readonly connectorId: string;
  readonly field: OrgCustomConnectorField;
  readonly configuredMarkers: ReadonlySet<string>;
}): boolean {
  return args.configuredMarkers.has(
    `${args.connectorId}:${customConnectorValueMarkerKey(args.field)}`,
  );
}

function customConnectorAuthTemplateConfigured(args: {
  readonly connectorId: string;
  readonly fields: readonly OrgCustomConnectorField[];
  readonly configuredMarkers: ReadonlySet<string>;
  readonly template: string;
  readonly oauthConnected: boolean;
}): boolean {
  const fieldByReference = new Map<string, OrgCustomConnectorField>(
    args.fields.map((field) => {
      return [
        `${field.kind === "secret" ? "secrets" : "variables"}.${field.key}`,
        field,
      ] as const;
    }),
  );

  const legacyField = args.fields.find((field) => {
    return field.kind === "secret" && field.key === LEGACY_SECRET_KEY;
  });
  if (args.template.includes(LEGACY_SECRET_PLACEHOLDER)) {
    if (!legacyField) {
      return false;
    }
    if (
      !customConnectorFieldConfigured({
        connectorId: args.connectorId,
        field: legacyField,
        configuredMarkers: args.configuredMarkers,
      })
    ) {
      return false;
    }
  }

  for (const match of args.template.matchAll(
    CUSTOM_CONNECTOR_TEMPLATE_REFERENCE_REGEX,
  )) {
    const namespace = match[1];
    const key = match[2];
    if (!namespace || !key) {
      continue;
    }
    if (namespace === "oauth") {
      if (key !== "access_token" || !args.oauthConnected) {
        return false;
      }
      continue;
    }
    const field = fieldByReference.get(`${namespace}.${key}`);
    if (!field) {
      return false;
    }
    if (
      !customConnectorFieldConfigured({
        connectorId: args.connectorId,
        field,
        configuredMarkers: args.configuredMarkers,
      })
    ) {
      return false;
    }
  }
  return true;
}

function customConnectorAuthTemplates(row: {
  readonly headerTemplate: string;
  readonly headerInjections: readonly OrgCustomConnectorHeaderInjection[];
  readonly queryInjections: readonly OrgCustomConnectorQueryInjection[];
}): readonly string[] {
  return [
    ...(row.headerInjections.length > 0
      ? row.headerInjections.map((injection) => {
          return injection.valueTemplate;
        })
      : [row.headerTemplate]),
    ...row.queryInjections.map((injection) => {
      return injection.valueTemplate;
    }),
  ];
}

function customConnectorPrefixTemplates(row: {
  readonly prefixes: readonly string[];
  readonly prefixTemplates: readonly string[];
}): readonly string[] {
  return row.prefixTemplates.length > 0 ? row.prefixTemplates : row.prefixes;
}

function customConnectorPrefixTemplateConfigured(args: {
  readonly connectorId: string;
  readonly fields: readonly OrgCustomConnectorField[];
  readonly configuredMarkers: ReadonlySet<string>;
  readonly template: string;
}): boolean {
  const variableFieldByKey = new Map(
    args.fields
      .filter((field) => {
        return field.kind === "variable";
      })
      .map((field) => {
        return [field.key, field] as const;
      }),
  );

  for (const match of args.template.matchAll(
    CUSTOM_CONNECTOR_TEMPLATE_REFERENCE_REGEX,
  )) {
    const namespace = match[1];
    const key = match[2];
    if (!namespace || !key) {
      continue;
    }
    if (namespace !== "variables") {
      return false;
    }
    const field = variableFieldByKey.get(key);
    if (!field) {
      return false;
    }
    if (
      !customConnectorFieldConfigured({
        connectorId: args.connectorId,
        field,
        configuredMarkers: args.configuredMarkers,
      })
    ) {
      return false;
    }
  }
  return true;
}

async function loadCustomConnectorGrantValueMarkers(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[];
  },
): Promise<ReadonlySet<string>> {
  const valueMarkers = await loadCurrentCustomConnectorValueMarkers(db, args);
  const markers = new Set<string>();
  for (const row of valueMarkers) {
    markers.add(
      `${row.connectorId}:${customConnectorValueMarkerKey({
        kind: row.kind,
        key: row.key,
      })}`,
    );
  }
  return markers;
}

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
  readonly prefixes: readonly string[];
  readonly prefixTemplates: readonly string[];
  readonly headerTemplate: string;
  readonly fields: readonly OrgCustomConnectorField[];
  readonly headerInjections: readonly OrgCustomConnectorHeaderInjection[];
  readonly queryInjections: readonly OrgCustomConnectorQueryInjection[];
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly oauthProviderAdapter: string | null;
  readonly permissionBundleRef: string | null;
}

interface LockedCustomConnectorValidation {
  readonly missingIds: readonly string[];
  readonly unconfiguredIds: readonly string[];
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
}

function customConnectorGrantIsConfigured(args: {
  readonly row: LockedCustomConnectorRow;
  readonly configuredMarkers: ReadonlySet<string>;
  readonly oauthConnected: boolean;
}): boolean {
  const fields =
    args.row.authMode === "manual"
      ? customConnectorGrantFields(args.row.fields)
      : args.row.fields;
  const missingRequired = fields.some((field) => {
    return (
      field.required &&
      !args.configuredMarkers.has(
        `${args.row.id}:${customConnectorValueMarkerKey(field)}`,
      )
    );
  });
  const hasConfiguredAuth = customConnectorAuthTemplates(args.row).some(
    (template) => {
      return customConnectorAuthTemplateConfigured({
        connectorId: args.row.id,
        fields,
        configuredMarkers: args.configuredMarkers,
        template,
        oauthConnected: args.oauthConnected,
      });
    },
  );
  const hasConfiguredPrefix = customConnectorPrefixTemplates(args.row).some(
    (template) => {
      return customConnectorPrefixTemplateConfigured({
        connectorId: args.row.id,
        fields,
        configuredMarkers: args.configuredMarkers,
        template,
      });
    },
  );
  return (
    !missingRequired &&
    hasConfiguredAuth &&
    hasConfiguredPrefix &&
    (args.row.authMode === "manual" || args.oauthConnected)
  );
}

async function lockCustomConnectorsForReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly enabledIds: readonly string[];
  },
): Promise<LockedCustomConnectorValidation> {
  if (args.enabledIds.length === 0) {
    return {
      missingIds: [],
      unconfiguredIds: [],
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
        prefixes: orgCustomConnectors.prefixes,
        prefixTemplates: orgCustomConnectors.prefixTemplates,
        headerTemplate: orgCustomConnectors.headerTemplate,
        fields: orgCustomConnectors.fields,
        headerInjections: orgCustomConnectors.headerInjections,
        queryInjections: orgCustomConnectors.queryInjections,
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
  const missingIds = args.enabledIds.filter((id) => {
    return !lockedIds.has(id);
  });
  if (missingIds.length > 0) {
    return {
      missingIds,
      unconfiguredIds: [],
      permissionBundleRefs: new Map(),
    };
  }

  const connectorIds = lockedRows.map((row) => {
    return row.id;
  });
  const [configuredMarkers, oauthConnectedIds] = await Promise.all([
    loadCustomConnectorGrantValueMarkers(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds,
    }),
    loadCurrentCustomConnectorOAuthConnectionIds(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds,
    }),
  ]);
  const unconfiguredIds = lockedRows.flatMap((row) => {
    return customConnectorGrantIsConfigured({
      row,
      configuredMarkers,
      oauthConnected: oauthConnectedIds.has(row.id),
    })
      ? []
      : [row.id];
  });
  return {
    missingIds: [],
    unconfiguredIds,
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
      .insert(userCustomConnectorsInsertTarget)
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
  const validation = await lockCustomConnectorsForReplace(args.tx, {
    orgId: args.request.orgId,
    userId: args.request.userId,
    enabledIds: args.enabledIds,
  });
  if (validation.missingIds.length > 0) {
    return {
      result: {
        status: "customConnectorsNotFound",
        missingIds: validation.missingIds,
      },
      previousIds,
    };
  }
  if (validation.unconfiguredIds.length > 0) {
    return {
      result: {
        status: "customConnectorsNotConfigured",
        unconfiguredIds: validation.unconfiguredIds,
      },
      previousIds,
    };
  }
  const permissionSelection = await validateCustomConnectorPermissionSelection({
    enabledIds: args.enabledIds,
    explicitGrants: args.request.grants !== undefined,
    grantByConnectorId: args.grantByConnectorId,
    permissionBundleRefs: validation.permissionBundleRefs,
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
    await publishCustomConnectorRuntimeSyncWakeups({
      db,
      scope: {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
      },
      customConnectorIds: [
        ...committed.previousIds,
        ...committed.result.enabledIds,
        ...enabledIds,
      ],
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
