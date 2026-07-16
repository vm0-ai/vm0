import { createHash } from "node:crypto";

import {
  connectorCatalogFilteredAuthMethodsSchema,
  type ConnectorCatalogCompatibilityReason,
  type ConnectorCatalogFilteredAuthMethod,
  type ConnectorCatalogFilteringStatus,
} from "@vm0/api-contracts/contracts/cron";
import {
  CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS,
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderMethodContract,
  type ConnectorAuthProviderRegistrationCapability,
} from "@vm0/connectors/auth-providers";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, eq, ne, or } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  connectorCatalogPrivateArtifactSchema,
  connectorCatalogPublicArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogPrivateArtifact,
} from "./connector-catalog-artifacts/artifacts";
import { connectorCatalogSource } from "./connector-catalog-sync.service";

const COMPATIBILITY_REASON_ORDER = [
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
] as const satisfies readonly ConnectorCatalogCompatibilityReason[];

// Bump when evaluator semantics change without changing a provider or generic
// capability projection, so rolling builds cannot reuse each other's reports.
const EXECUTABLE_CAPABILITY_EVALUATOR_VERSION = 1;

type PrivateAuthMethod =
  ConnectorCatalogPrivateArtifact["connectors"][number]["authMethods"][number];

interface ExecutableCapabilityState {
  readonly digest: string;
  readonly configuredNames: ReadonlySet<string>;
  readonly registrations: readonly ConnectorAuthProviderRegistrationCapability[];
}

interface ActiveSnapshotIdentity {
  readonly catalogVersion: string;
  readonly integrityDigest: string;
}

interface ActiveSnapshot extends ActiveSnapshotIdentity {
  readonly publicCatalog: string;
  readonly privateCatalog: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function registrationKey(connectorRef: string, authMethodId: string): string {
  return `${connectorRef}\0${authMethodId}`;
}

function executableCapabilityState(): ExecutableCapabilityState {
  const registrations = getConnectorAuthProviderRegistrationCapabilities();
  const configurationNames = [
    ...new Set(
      registrations.flatMap((registration) => {
        return registration.requiredConfigurationNames;
      }),
    ),
  ].sort(compareStrings);
  const configuration = configurationNames.map((name) => {
    return { name, present: optionalEnv(name) !== undefined };
  });
  const preimage = JSON.stringify({
    evaluatorVersion: EXECUTABLE_CAPABILITY_EVALUATOR_VERSION,
    generic: CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS,
    registrations,
    configuration,
  });
  return {
    digest: `sha256:${createHash("sha256").update(preimage).digest("hex")}`,
    configuredNames: new Set(
      configuration.flatMap(({ name, present }) => {
        return present ? [name] : [];
      }),
    ),
    registrations,
  };
}

export function connectorCatalogExecutableCapabilityDigest(): string {
  return executableCapabilityState().digest;
}

function privateClientContract(
  method: PrivateAuthMethod,
): ConnectorAuthProviderMethodContract["client"] {
  const client = method.client;
  if (client === undefined) {
    return { kind: "none" };
  }
  if (client.clientRegistration === "dynamic") {
    return { kind: "dynamic-public" };
  }
  if (client.clientType === "confidential") {
    return {
      kind: "static-confidential-env",
      clientIdEnv: client.clientIdEnv,
      clientSecretEnv: client.clientSecretEnv,
    };
  }
  return { kind: "static-public-literal" };
}

function privateMethodContract(
  method: PrivateAuthMethod,
): ConnectorAuthProviderMethodContract {
  const grantOutputNames =
    method.grant.kind === "manual"
      ? []
      : Object.keys(method.grant.outputs).sort(compareStrings);
  const startOptionNames =
    method.grant.kind === "device-auth"
      ? method.grant.startOptionMappings
          .map((mapping) => {
            return mapping.privateName;
          })
          .sort(compareStrings)
      : [];
  return {
    client: privateClientContract(method),
    grant: {
      kind: method.grant.kind,
      callbackOrigin:
        method.grant.kind === "auth-code" || method.grant.kind === "openid-auth"
          ? method.grant.callbackOrigin
          : null,
      outputNames: grantOutputNames,
      startOptionNames,
    },
    access: {
      kind: method.access.kind,
      inputNames:
        method.access.kind === "refresh-token"
          ? Object.keys(method.access.inputs).sort(compareStrings)
          : [],
      outputNames:
        method.access.kind === "refresh-token"
          ? Object.keys(method.access.outputs).sort(compareStrings)
          : [],
      platformSecrets: [...(method.access.platformSecrets ?? [])].sort(
        compareStrings,
      ),
    },
    revoke: {
      kind: method.revoke.kind,
      inputNames:
        method.revoke.kind === "token-revoke"
          ? Object.keys(method.revoke.inputs).sort(compareStrings)
          : [],
    },
  };
}

function addProviderReasons(
  reasons: Set<ConnectorCatalogCompatibilityReason>,
  method: PrivateAuthMethod,
  registration: ConnectorAuthProviderRegistrationCapability | undefined,
): void {
  if (
    method.grant.kind !== "manual" &&
    registration?.handlers.grant !== method.grant.kind
  ) {
    reasons.add("missing-grant-provider");
  }
  if (
    method.access.kind === "refresh-token" &&
    registration?.handlers.access !== "refresh-token"
  ) {
    reasons.add("missing-access-provider");
  }
  if (
    method.revoke.kind === "token-revoke" &&
    registration?.handlers.revoke !== "token-revoke"
  ) {
    reasons.add("missing-revoke-provider");
  }
}

function hasUnapprovedConfigurationIdentity(
  contract: ConnectorAuthProviderMethodContract,
): boolean {
  return (
    contract.client.kind === "static-confidential-env" ||
    contract.client.kind === "static-public-env" ||
    contract.access.platformSecrets.length > 0
  );
}

function evaluateMethod(args: {
  readonly method: PrivateAuthMethod;
  readonly registration:
    | ConnectorAuthProviderRegistrationCapability
    | undefined;
  readonly configuredNames: ReadonlySet<string>;
}): ConnectorCatalogCompatibilityReason[] {
  const reasons = new Set<ConnectorCatalogCompatibilityReason>();
  addProviderReasons(reasons, args.method, args.registration);

  const contract = privateMethodContract(args.method);
  const contractMatches =
    args.registration === undefined
      ? !hasUnapprovedConfigurationIdentity(contract)
      : JSON.stringify(args.registration.contract) === JSON.stringify(contract);
  if (!contractMatches) {
    reasons.add("provider-contract-mismatch");
  } else if (
    args.registration?.requiredConfigurationNames.some((name) => {
      return !args.configuredNames.has(name);
    })
  ) {
    reasons.add("missing-platform-configuration");
  }

  return COMPATIBILITY_REASON_ORDER.filter((reason) => {
    return reasons.has(reason);
  });
}

function evaluateSnapshot(
  snapshot: ActiveSnapshot,
  capability: ExecutableCapabilityState,
): ConnectorCatalogFilteredAuthMethod[] {
  const publicJson: unknown = JSON.parse(snapshot.publicCatalog);
  const privateJson: unknown = JSON.parse(snapshot.privateCatalog);
  const publicArtifact = connectorCatalogPublicArtifactSchema.parse(publicJson);
  const privateArtifact =
    connectorCatalogPrivateArtifactSchema.parse(privateJson);
  if (
    publicArtifact.catalogVersion !== snapshot.catalogVersion ||
    privateArtifact.catalogVersion !== snapshot.catalogVersion
  ) {
    throw new Error("Connector catalog snapshot identity mismatch");
  }

  const registrations = new Map(
    capability.registrations.map((registration) => {
      return [
        registrationKey(registration.connectorRef, registration.authMethodId),
        registration,
      ];
    }),
  );
  const filtered = privateArtifact.connectors.flatMap((connector) => {
    return connector.authMethods.flatMap((method) => {
      const reasons = evaluateMethod({
        method,
        registration: registrations.get(
          registrationKey(connector.connectorRef, method.id),
        ),
        configuredNames: capability.configuredNames,
      });
      return reasons.length === 0
        ? []
        : [
            {
              connectorRef: connector.connectorRef,
              authMethodId: method.id,
              reasons,
            },
          ];
    });
  });
  return filtered.sort((left, right) => {
    return (
      compareStrings(left.connectorRef, right.connectorRef) ||
      compareStrings(left.authMethodId, right.authMethodId)
    );
  });
}

async function lockSyncState(db: Db, sourceId: string): Promise<boolean> {
  const [state] = await db
    .select({ sourceId: connectorCatalogSyncState.sourceId })
    .from(connectorCatalogSyncState)
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1)
    .for("update");
  return state !== undefined;
}

async function activeSnapshotForUpdate(
  db: Db,
  sourceId: string,
): Promise<ActiveSnapshot | undefined> {
  const [snapshot] = await db
    .select({
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      integrityDigest: connectorCatalogActiveSnapshot.integrityDigest,
      publicCatalog: connectorCatalogActiveSnapshot.publicCatalog,
      privateCatalog: connectorCatalogActiveSnapshot.privateCatalog,
    })
    .from(connectorCatalogActiveSnapshot)
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1)
    .for("update");
  return snapshot;
}

function staleFilteringStatus(
  capabilityDigest: string,
): ConnectorCatalogFilteringStatus {
  return {
    capabilityDigest,
    evaluatedAt: null,
    stale: true,
    filteredAuthMethods: [],
  };
}

async function reconcileCompatibility(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly capability: ExecutableCapabilityState;
}): Promise<void> {
  const hasState = await lockSyncState(args.db, args.sourceId);
  if (!hasState) {
    return;
  }
  const snapshot = await activeSnapshotForUpdate(args.db, args.sourceId);
  if (snapshot === undefined) {
    return;
  }

  await args.db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        or(
          ne(
            connectorCatalogCompatibilityEvaluation.catalogVersion,
            snapshot.catalogVersion,
          ),
          ne(
            connectorCatalogCompatibilityEvaluation.integrityDigest,
            snapshot.integrityDigest,
          ),
        ),
      ),
    );

  const [existing] = await args.db
    .select({
      capabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogVersion,
          snapshot.catalogVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.integrityDigest,
          snapshot.integrityDigest,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          args.capability.digest,
        ),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    return;
  }

  const filteredAuthMethods = evaluateSnapshot(snapshot, args.capability);
  const evaluatedAt = nowDate();
  await args.db.insert(connectorCatalogCompatibilityEvaluation).values({
    sourceId: args.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: snapshot.catalogVersion,
    integrityDigest: snapshot.integrityDigest,
    executableCapabilityDigest: args.capability.digest,
    evaluatedAt,
    filteredAuthMethods: [...filteredAuthMethods],
  });
}

async function compatibilityStatus(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
  readonly snapshot: ActiveSnapshotIdentity | null;
}): Promise<ConnectorCatalogFilteringStatus> {
  if (args.snapshot === null) {
    return staleFilteringStatus(args.capabilityDigest);
  }

  const [result] = await args.db
    .select({
      evaluatedAt: connectorCatalogCompatibilityEvaluation.evaluatedAt,
      filteredAuthMethods:
        connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogVersion,
          args.snapshot.catalogVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.integrityDigest,
          args.snapshot.integrityDigest,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          args.capabilityDigest,
        ),
      ),
    )
    .limit(1);
  if (result === undefined) {
    return staleFilteringStatus(args.capabilityDigest);
  }
  return {
    capabilityDigest: args.capabilityDigest,
    evaluatedAt: result.evaluatedAt.toISOString(),
    stale: false,
    filteredAuthMethods: connectorCatalogFilteredAuthMethodsSchema.parse(
      result.filteredAuthMethods,
    ),
  };
}

export const reconcileConnectorCatalogCompatibility$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const source = connectorCatalogSource();
    const capability = executableCapabilityState();
    await set(writeDb$).transaction(async (tx) => {
      await reconcileCompatibility({
        db: tx,
        sourceId: source.sourceId,
        capability,
      });
    });
    signal.throwIfAborted();
  },
);

export const connectorCatalogCompatibilityStatus$ = command(
  async (
    { get },
    snapshot: ActiveSnapshotIdentity | null,
    signal: AbortSignal,
  ): Promise<ConnectorCatalogFilteringStatus> => {
    const source = connectorCatalogSource();
    const capability = executableCapabilityState();
    const status = await compatibilityStatus({
      db: get(db$),
      sourceId: source.sourceId,
      capabilityDigest: capability.digest,
      snapshot,
    });
    signal.throwIfAborted();
    return status;
  },
);
