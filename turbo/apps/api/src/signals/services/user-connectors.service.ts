import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  orgCustomConnectors,
  type OrgCustomConnectorField,
  type OrgCustomConnectorAuthMode,
  type OrgCustomConnectorHeaderInjection,
  type OrgCustomConnectorQueryInjection,
} from "@vm0/db/schema/org-custom-connector";
import { connectors as connectorConnections } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import type { Db } from "../external/db";

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
    }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    }
  | {
      readonly status: "customConnectorsNotConfigured";
      readonly unconfiguredIds: readonly string[];
    };

type UserCustomConnectorUpdateOperation = "replace" | "add" | "remove";

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
  if (args.connectorIds.length === 0) {
    return new Set();
  }

  const valueRows = await db
    .select({
      connectorId: orgCustomConnectorValues.connectorId,
      kind: orgCustomConnectorValues.kind,
      key: orgCustomConnectorValues.key,
    })
    .from(orgCustomConnectorValues)
    .where(
      and(
        eq(orgCustomConnectorValues.orgId, args.orgId),
        eq(orgCustomConnectorValues.userId, args.userId),
        inArray(orgCustomConnectorValues.connectorId, [...args.connectorIds]),
      ),
    );
  const legacyRows = await db
    .select({ connectorId: orgCustomConnectorSecrets.connectorId })
    .from(orgCustomConnectorSecrets)
    .where(
      and(
        eq(orgCustomConnectorSecrets.orgId, args.orgId),
        eq(orgCustomConnectorSecrets.userId, args.userId),
        inArray(orgCustomConnectorSecrets.connectorId, [...args.connectorIds]),
      ),
    );

  const markers = new Set<string>();
  for (const row of valueRows) {
    if (row.kind !== "secret" && row.kind !== "variable") {
      continue;
    }
    markers.add(
      `${row.connectorId}:${customConnectorValueMarkerKey({
        kind: row.kind,
        key: row.key,
      })}`,
    );
  }
  for (const row of legacyRows) {
    markers.add(
      `${row.connectorId}:${customConnectorValueMarkerKey({
        kind: "secret",
        key: LEGACY_SECRET_KEY,
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

interface LockedCustomConnectorRow {
  readonly id: string;
  readonly prefixes: readonly string[];
  readonly prefixTemplates: readonly string[];
  readonly headerTemplate: string;
  readonly fields: readonly OrgCustomConnectorField[];
  readonly headerInjections: readonly OrgCustomConnectorHeaderInjection[];
  readonly queryInjections: readonly OrgCustomConnectorQueryInjection[];
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly revision: number;
}

async function loadCustomConnectorOAuthConnectionIds(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[];
  },
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({
      customConnectorId: connectorConnections.customConnectorId,
    })
    .from(connectorConnections)
    .innerJoin(
      secrets,
      and(
        eq(secrets.connectorId, connectorConnections.id),
        eq(secrets.name, "access_token"),
      ),
    )
    .where(
      and(
        eq(connectorConnections.orgId, args.orgId),
        eq(connectorConnections.userId, args.userId),
        eq(connectorConnections.authMethod, "oauth"),
        eq(connectorConnections.needsReconnect, false),
        inArray(connectorConnections.customConnectorId, [...args.connectorIds]),
      ),
    );
  return new Set(
    rows.flatMap((row) => {
      return row.customConnectorId ? [row.customConnectorId] : [];
    }),
  );
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
): Promise<{
  readonly missingIds: readonly string[];
  readonly unconfiguredIds: readonly string[];
  readonly revisions: ReadonlyMap<string, number>;
}> {
  if (args.enabledIds.length === 0) {
    return { missingIds: [], unconfiguredIds: [], revisions: new Map() };
  }

  const sortedIds = [...args.enabledIds].sort();
  const lockedRows: LockedCustomConnectorRow[] = [];
  for (const id of sortedIds) {
    const [locked] = await db
      .select({
        id: orgCustomConnectors.id,
        prefixes: orgCustomConnectors.prefixes,
        prefixTemplates: orgCustomConnectors.prefixTemplates,
        headerTemplate: orgCustomConnectors.headerTemplate,
        fields: orgCustomConnectors.fields,
        headerInjections: orgCustomConnectors.headerInjections,
        queryInjections: orgCustomConnectors.queryInjections,
        authMode: orgCustomConnectors.authMode,
        revision: orgCustomConnectors.revision,
      })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.id, id),
          eq(orgCustomConnectors.enabled, true),
        ),
      )
      .for("update")
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
    return { missingIds, unconfiguredIds: [], revisions: new Map() };
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
    loadCustomConnectorOAuthConnectionIds(db, {
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
    revisions: new Map(
      lockedRows.map((row) => {
        return [row.id, row.revision] as const;
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
            inArray(userConnectors.connectorType, enabledConnectorSlugs),
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
              connectorType: connectorSlug,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (operation === "replace") {
      return { status: "updated", enabledConnectorSlugs };
    }

    const rows = await tx
      .select({ connectorSlug: userConnectors.connectorType })
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

export async function updateUserCustomConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledIds: readonly string[];
    readonly operation?: UserCustomConnectorUpdateOperation;
  },
): Promise<UpdateUserCustomConnectorsResult> {
  const enabledIds = Array.from(new Set(args.enabledIds));
  const operation = args.operation ?? "replace";

  return await db.transaction(async (tx) => {
    const composeLocked = await lockAgentComposeForConnectorReplace(tx, args);
    if (!composeLocked) {
      return { status: "agentNotFound" };
    }

    const agentLocked = await lockZeroAgentForConnectorReplace(tx, args);
    if (!agentLocked) {
      return { status: "agentNotFound" };
    }

    let connectorRevisions: ReadonlyMap<string, number> = new Map();
    if (operation !== "remove") {
      const validation = await lockCustomConnectorsForReplace(tx, {
        orgId: args.orgId,
        userId: args.userId,
        enabledIds,
      });
      if (validation.missingIds.length > 0) {
        return {
          status: "customConnectorsNotFound",
          missingIds: validation.missingIds,
        };
      }
      if (validation.unconfiguredIds.length > 0) {
        return {
          status: "customConnectorsNotConfigured",
          unconfiguredIds: validation.unconfiguredIds,
        };
      }
      connectorRevisions = validation.revisions;
    }

    const connectorScope = and(
      eq(userCustomConnectors.orgId, args.orgId),
      eq(userCustomConnectors.userId, args.userId),
      eq(userCustomConnectors.agentId, args.agentId),
    );

    if (operation === "replace") {
      await tx.delete(userCustomConnectors).where(connectorScope);
    } else if (operation === "remove" && enabledIds.length > 0) {
      await tx
        .delete(userCustomConnectors)
        .where(
          and(
            connectorScope,
            inArray(userCustomConnectors.customConnectorId, enabledIds),
          ),
        );
    }

    if (operation !== "remove" && enabledIds.length > 0) {
      await tx
        .insert(userCustomConnectors)
        .values(
          enabledIds.map((customConnectorId) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              customConnectorId,
              connectorRevision: connectorRevisions.get(customConnectorId) ?? 1,
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
            connectorRevision: sql`excluded.connector_revision`,
          },
        });
    }

    if (operation === "replace") {
      return { status: "updated", enabledIds };
    }

    const rows = await tx
      .select({ customConnectorId: userCustomConnectors.customConnectorId })
      .from(userCustomConnectors)
      .where(connectorScope);
    return {
      status: "updated",
      enabledIds: rows.map((row) => {
        return row.customConnectorId;
      }),
    };
  });
}

export async function addUserCustomConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly customConnectorId: string;
  },
): Promise<AddUserCustomConnectorResult> {
  const result = await updateUserCustomConnectors(db, {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    enabledIds: [args.customConnectorId],
    operation: "add",
  });
  if (result.status === "updated") {
    return { status: "added" };
  }
  return result;
}
