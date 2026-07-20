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
import { alias, unionAll } from "drizzle-orm/pg-core";

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

type ReadinessCountKind =
  | "bridge-secrets"
  | "bridge-variables"
  | "missing-connector-versions"
  | "unowned-connector-secrets"
  | "unowned-connector-variables";

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
  if (rows.length === 0) {
    return sql`VALUES (NULL::text, NULL::text, NULL::bigint, NULL::text)`;
  }
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

function readinessCountKind(kind: ReadinessCountKind) {
  return sql<ReadinessCountKind>`${kind}::text`.as("kind");
}

function bridgeResolvableSecretsQuery(
  db: ReadonlyDb,
  contracts: readonly BridgeContractRow[],
) {
  const secretContracts = contracts.filter((row) => {
    return row.kind === "secret";
  });
  const candidateConnector = alias(connectors, "secret_readiness_connector");
  return db
    .select({
      kind: readinessCountKind("bridge-secrets"),
      value: countDistinct(secrets.id),
    })
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
}

function bridgeResolvableVariablesQuery(
  db: ReadonlyDb,
  contracts: readonly BridgeContractRow[],
) {
  const variableContracts = contracts.filter((row) => {
    return row.kind === "variable";
  });
  const candidateConnector = alias(connectors, "variable_readiness_connector");
  return db
    .select({
      kind: readinessCountKind("bridge-variables"),
      value: countDistinct(variables.id),
    })
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
}

export async function loadConnectorCredentialReadiness(
  db: ReadonlyDb,
  snapshot: ConnectorRuntimeSnapshot | null,
): Promise<ConnectorCredentialReadiness> {
  const contracts = bridgeContractRows(snapshot);
  // One UNION statement gives every count the same PostgreSQL statement
  // snapshot, so concurrent credential claims cannot produce contradictory
  // totals (including a transient negative unresolved count).
  const rows = await unionAll(
    db
      .select({
        kind: readinessCountKind("missing-connector-versions"),
        value: count(),
      })
      .from(connectors)
      .where(isNull(connectors.storageVersion)),
    db
      .select({
        kind: readinessCountKind("unowned-connector-secrets"),
        value: count(),
      })
      .from(secrets)
      .where(and(eq(secrets.type, "connector"), isNull(secrets.connectorId))),
    db
      .select({
        kind: readinessCountKind("unowned-connector-variables"),
        value: count(),
      })
      .from(variables)
      .where(
        and(eq(variables.type, "connector"), isNull(variables.connectorId)),
      ),
    bridgeResolvableSecretsQuery(db, contracts),
    bridgeResolvableVariablesQuery(db, contracts),
  );
  const counts = new Map(
    rows.map((row) => {
      return [row.kind, row.value] as const;
    }),
  );
  const missingConnectorVersions =
    counts.get("missing-connector-versions") ?? 0;
  const unownedConnectorSecrets = counts.get("unowned-connector-secrets") ?? 0;
  const unownedConnectorVariables =
    counts.get("unowned-connector-variables") ?? 0;
  const bridgeSecrets = counts.get("bridge-secrets") ?? 0;
  const bridgeVariables = counts.get("bridge-variables") ?? 0;
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
