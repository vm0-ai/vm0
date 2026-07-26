import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodOwnedVariableNames,
  connectorAuthMethodRuntimeMetadata,
} from "@vm0/connectors/connector-auth-method";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ReadonlyDb } from "../external/db";
import {
  getConnectorRuntimeMethod,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";

/**
 * One executable stored connection, resolved against one immutable catalog
 * snapshot. Feature-switch visibility is discovery policy and deliberately
 * does not participate in this access boundary: disabling discovery must not
 * invalidate an already compatible stored connection.
 */
export interface ConnectorCredentialAccess {
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorRef: string;
  readonly orgId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly storageVersion: number;
  readonly userId: string;
}

type ConnectorCredentialAccessResult =
  | { readonly kind: "ok"; readonly access: ConnectorCredentialAccess }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

interface ConnectorCredentialStoredIdentity {
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorRef: string;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly userId: string;
}

export interface ConnectorCredentialReadGroup {
  readonly access: ConnectorCredentialAccess;
  /**
   * Multi-phase readers may pin the connector row they originally observed.
   * Single-statement and connector-locked callers do not need this condition.
   */
  readonly connectorStateRevision?: bigint;
  readonly names: readonly string[];
}

const credentialAccessConnector = alias(
  connectors,
  "credential_access_connector",
);

export function connectorCredentialStorageIsCompatible(args: {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly storageVersion: number;
}): boolean {
  return args.storageVersion === args.runtimeMethod.method.storage.version;
}

export function resolveConnectorCredentialAccess(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly stored: ConnectorCredentialStoredIdentity;
}): ConnectorCredentialAccessResult {
  const runtimeMethod = getConnectorRuntimeMethod({
    snapshot: args.snapshot,
    connectorRef: args.stored.connectorRef,
    authMethodId: args.stored.authMethodId,
    requireExecutable: true,
  });
  if (!runtimeMethod) {
    return { kind: "unavailable" };
  }
  if (
    !connectorCredentialStorageIsCompatible({
      runtimeMethod,
      storageVersion: args.stored.storageVersion,
    })
  ) {
    return { kind: "incompatible" };
  }
  return {
    kind: "ok",
    access: {
      authMethodId: args.stored.authMethodId,
      connectorId: args.stored.connectorId,
      connectorRef: args.stored.connectorRef,
      orgId: args.stored.orgId,
      runtimeMethod,
      storageVersion: runtimeMethod.method.storage.version,
      userId: args.stored.userId,
    },
  };
}

function assertDeclaredNames(args: {
  readonly access: ConnectorCredentialAccess;
  readonly kind: "secret" | "variable";
  readonly names: readonly string[];
}): void {
  const declaredNames = new Set(
    args.kind === "secret"
      ? connectorAuthMethodOwnedSecretNames(args.access.runtimeMethod.method)
      : connectorAuthMethodOwnedVariableNames(args.access.runtimeMethod.method),
  );
  for (const name of args.names) {
    if (!declaredNames.has(name)) {
      throw new Error(
        `Connector ${args.kind} is not declared by the selected auth method`,
      );
    }
  }
}

function connectorIdentityExists(
  db: ReadonlyDb,
  access: ConnectorCredentialAccess,
  connectorStateRevision: bigint | undefined,
): SQL {
  return exists(
    db
      .select({ connectorId: credentialAccessConnector.id })
      .from(credentialAccessConnector)
      .where(
        and(
          eq(credentialAccessConnector.id, access.connectorId),
          eq(credentialAccessConnector.orgId, access.orgId),
          eq(credentialAccessConnector.userId, access.userId),
          eq(credentialAccessConnector.type, access.connectorRef),
          eq(credentialAccessConnector.authMethod, access.authMethodId),
          eq(credentialAccessConnector.storageVersion, access.storageVersion),
          connectorStateRevision === undefined
            ? undefined
            : sql`(
                EXTRACT(EPOCH FROM ${credentialAccessConnector.updatedAt})
                * 1000000
              )::bigint = ${connectorStateRevision}`,
        ),
      ),
  );
}

export function connectorCredentialSecretReadCondition(args: {
  readonly db: ReadonlyDb;
  readonly groups: readonly ConnectorCredentialReadGroup[];
}): SQL | undefined {
  const conditions = args.groups.flatMap((group) => {
    const names = [...new Set(group.names)];
    if (names.length === 0) {
      return [];
    }
    assertDeclaredNames({
      access: group.access,
      kind: "secret",
      names,
    });
    return [
      and(
        eq(secrets.orgId, group.access.orgId),
        eq(secrets.userId, group.access.userId),
        eq(secrets.type, "connector"),
        inArray(secrets.name, names),
        eq(secrets.connectorId, group.access.connectorId),
        connectorIdentityExists(
          args.db,
          group.access,
          group.connectorStateRevision,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(secrets.id) : or(...conditions);
}

export function connectorCredentialVariableReadCondition(args: {
  readonly db: ReadonlyDb;
  readonly groups: readonly ConnectorCredentialReadGroup[];
}): SQL | undefined {
  const conditions = args.groups.flatMap((group) => {
    const names = [...new Set(group.names)];
    if (names.length === 0) {
      return [];
    }
    assertDeclaredNames({
      access: group.access,
      kind: "variable",
      names,
    });
    return [
      and(
        eq(variables.orgId, group.access.orgId),
        eq(variables.userId, group.access.userId),
        eq(variables.type, "connector"),
        inArray(variables.name, names),
        eq(variables.connectorId, group.access.connectorId),
        connectorIdentityExists(
          args.db,
          group.access,
          group.connectorStateRevision,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(variables.id) : or(...conditions);
}

export function connectorCredentialStoredSecretDisplayInfo(args: {
  readonly access: ConnectorCredentialAccess;
  readonly name: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): {
  readonly environmentNames: readonly string[];
  readonly label: string;
} | null {
  if (
    !connectorAuthMethodOwnedSecretNames(
      args.access.runtimeMethod.method,
    ).includes(args.name)
  ) {
    return null;
  }
  const connector = args.snapshot.connectors.get(args.access.connectorRef);
  if (connector === undefined) {
    return null;
  }
  const environmentNames = [
    ...new Set(
      connectorAuthMethodRuntimeMetadata(
        args.access.runtimeMethod.method,
      ).runtimeBindings.flatMap((binding) => {
        return binding.source.kind === "connector-secret" &&
          binding.source.name === args.name
          ? [binding.envName]
          : [];
      }),
    ),
  ];
  return environmentNames.length === 0
    ? null
    : { environmentNames, label: connector.catalogConnector.label };
}
