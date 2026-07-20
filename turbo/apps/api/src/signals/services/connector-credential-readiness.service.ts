import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodOwnedVariableNames,
} from "@vm0/connectors/connector-utils";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import {
  and,
  count,
  countDistinct,
  eq,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ReadonlyDb } from "../external/db";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";

interface ConnectorCredentialReadiness {
  readonly missingConnectorVersions: number;
  readonly unownedConnectorSecrets: number;
  readonly unownedConnectorVariables: number;
  readonly unresolvedBridgeCredentials: number;
}

interface BridgeContractRow {
  readonly authMethodId: string;
  readonly connectorRef: string;
  readonly kind: "secret" | "variable";
  readonly name: string;
  readonly storageVersion: number;
}

function ambiguousNamesByKind(snapshot: ConnectorRuntimeSnapshot): {
  readonly secret: ReadonlySet<string>;
  readonly variable: ReadonlySet<string>;
} {
  const refsBySecretName = new Map<string, Set<string>>();
  const refsByVariableName = new Map<string, Set<string>>();
  for (const connector of snapshot.connectors.values()) {
    for (const runtimeMethod of connector.methods.values()) {
      if (!runtimeMethod.executable) {
        continue;
      }
      for (const name of connectorAuthMethodOwnedSecretNames(
        runtimeMethod.method,
      )) {
        const refs = refsBySecretName.get(name) ?? new Set<string>();
        refs.add(runtimeMethod.connectorRef);
        refsBySecretName.set(name, refs);
      }
      for (const name of connectorAuthMethodOwnedVariableNames(
        runtimeMethod.method,
      )) {
        const refs = refsByVariableName.get(name) ?? new Set<string>();
        refs.add(runtimeMethod.connectorRef);
        refsByVariableName.set(name, refs);
      }
    }
  }
  return {
    secret: new Set(
      [...refsBySecretName].flatMap(([name, refs]) => {
        return refs.size > 1 ? [name] : [];
      }),
    ),
    variable: new Set(
      [...refsByVariableName].flatMap(([name, refs]) => {
        return refs.size > 1 ? [name] : [];
      }),
    ),
  };
}

function bridgeContractRows(
  snapshot: ConnectorRuntimeSnapshot | null,
): readonly BridgeContractRow[] {
  if (snapshot === null || snapshot.identity.source !== "static") {
    return [];
  }
  const ambiguous = ambiguousNamesByKind(snapshot);
  return [...snapshot.connectors.values()].flatMap((connector) => {
    return [...connector.methods.values()].flatMap((runtimeMethod) => {
      if (!runtimeMethod.executable) {
        return [];
      }
      const common = {
        authMethodId: runtimeMethod.authMethodId,
        connectorRef: runtimeMethod.connectorRef,
        storageVersion: runtimeMethod.method.storage.version,
      };
      return [
        ...connectorAuthMethodOwnedSecretNames(runtimeMethod.method).flatMap(
          (name): BridgeContractRow[] => {
            return ambiguous.secret.has(name)
              ? []
              : [{ ...common, kind: "secret", name }];
          },
        ),
        ...connectorAuthMethodOwnedVariableNames(runtimeMethod.method).flatMap(
          (name): BridgeContractRow[] => {
            return ambiguous.variable.has(name)
              ? []
              : [{ ...common, kind: "variable", name }];
          },
        ),
      ];
    });
  });
}

function bridgeContractValues(rows: readonly BridgeContractRow[]): SQL {
  return sql`VALUES ${sql.join(
    rows.map((row) => {
      return sql`(
        ${row.connectorRef}::text,
        ${row.authMethodId}::text,
        ${row.storageVersion}::bigint,
        ${row.name}::text
      )`;
    }),
    sql`, `,
  )}`;
}

function bridgeContractTable(rows: readonly BridgeContractRow[]): SQL {
  return sql`(${bridgeContractValues(rows)}) AS bridge_contract(
    connector_ref,
    auth_method,
    storage_version,
    credential_name
  )`;
}

async function countBridgeResolvableSecrets(
  db: ReadonlyDb,
  contracts: readonly BridgeContractRow[],
): Promise<number> {
  const secretContracts = contracts.filter((row) => {
    return row.kind === "secret";
  });
  if (secretContracts.length === 0) {
    return 0;
  }
  const candidateConnector = alias(connectors, "secret_readiness_connector");
  const [row] = await db
    .select({ value: countDistinct(secrets.id) })
    .from(secrets)
    .innerJoin(
      bridgeContractTable(secretContracts),
      sql`bridge_contract.credential_name = ${secrets.name}`,
    )
    .innerJoin(
      candidateConnector,
      and(
        eq(candidateConnector.orgId, secrets.orgId),
        eq(candidateConnector.userId, secrets.userId),
        sql`${candidateConnector.type} = bridge_contract.connector_ref`,
        sql`${candidateConnector.authMethod} = bridge_contract.auth_method`,
        sql`${candidateConnector.storageVersion} = bridge_contract.storage_version`,
      ),
    )
    .where(and(eq(secrets.type, "connector"), isNull(secrets.connectorId)));
  return row?.value ?? 0;
}

async function countBridgeResolvableVariables(
  db: ReadonlyDb,
  contracts: readonly BridgeContractRow[],
): Promise<number> {
  const variableContracts = contracts.filter((row) => {
    return row.kind === "variable";
  });
  if (variableContracts.length === 0) {
    return 0;
  }
  const candidateConnector = alias(connectors, "variable_readiness_connector");
  const [row] = await db
    .select({ value: countDistinct(variables.id) })
    .from(variables)
    .innerJoin(
      bridgeContractTable(variableContracts),
      sql`bridge_contract.credential_name = ${variables.name}`,
    )
    .innerJoin(
      candidateConnector,
      and(
        eq(candidateConnector.orgId, variables.orgId),
        eq(candidateConnector.userId, variables.userId),
        sql`${candidateConnector.type} = bridge_contract.connector_ref`,
        sql`${candidateConnector.authMethod} = bridge_contract.auth_method`,
        sql`${candidateConnector.storageVersion} = bridge_contract.storage_version`,
      ),
    )
    .where(and(eq(variables.type, "connector"), isNull(variables.connectorId)));
  return row?.value ?? 0;
}

export async function loadConnectorCredentialReadiness(
  db: ReadonlyDb,
  snapshot: ConnectorRuntimeSnapshot | null,
): Promise<ConnectorCredentialReadiness> {
  const contracts = bridgeContractRows(snapshot);
  const [
    missingVersionRows,
    unownedSecretRows,
    unownedVariableRows,
    bridgeSecrets,
    bridgeVariables,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(connectors)
      .where(isNull(connectors.storageVersion)),
    db
      .select({ value: count() })
      .from(secrets)
      .where(and(eq(secrets.type, "connector"), isNull(secrets.connectorId))),
    db
      .select({ value: count() })
      .from(variables)
      .where(
        and(eq(variables.type, "connector"), isNull(variables.connectorId)),
      ),
    countBridgeResolvableSecrets(db, contracts),
    countBridgeResolvableVariables(db, contracts),
  ]);
  const missingConnectorVersions = missingVersionRows[0]?.value ?? 0;
  const unownedConnectorSecrets = unownedSecretRows[0]?.value ?? 0;
  const unownedConnectorVariables = unownedVariableRows[0]?.value ?? 0;
  return {
    missingConnectorVersions,
    unownedConnectorSecrets,
    unownedConnectorVariables,
    unresolvedBridgeCredentials:
      unownedConnectorSecrets +
      unownedConnectorVariables -
      bridgeSecrets -
      bridgeVariables,
  };
}
