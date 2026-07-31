import { createHash } from "node:crypto";

import {
  connectorCatalogCompatibilityReasonSchema,
  type ConnectorCatalogCompatibilityReason,
  type ConnectorCatalogFilteredAuthMethod,
  type ConnectorCatalogFilteringStatus,
} from "@vm0/api-contracts/contracts/connector-catalog-diagnostics";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "@vm0/api-contracts/contracts/connector-identity";
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
import type {
  CanonicalConnectorCatalogCompatibilityEvaluation,
  CanonicalConnectorCatalogFilteredAuthMethod,
  ConnectorCatalogCompatibilityEvaluationPayload,
  LegacyConnectorCatalogCompatibilityEvaluation,
} from "@vm0/db/jsonb-contracts/connector-catalog";
import { command } from "ccstate";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogAuthMethod,
} from "./connector-catalog-artifacts/artifacts";
import { decodeConnectorCatalogSnapshot } from "./connector-catalog-artifacts/loader";
import { connectorCatalogSource } from "./connector-catalog-source";
import {
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

const COMPATIBILITY_REASON_ORDER = [
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
] as const satisfies readonly ConnectorCatalogCompatibilityReason[];

const legacyConnectorCatalogCompatibilityEvaluationSchema: z.ZodType<LegacyConnectorCatalogCompatibilityEvaluation> =
  z.array(
    z
      .object({
        connectorRef: connectorSlugSchema,
        authMethodId: connectorAuthMethodIdSchema,
        reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
      })
      .strict(),
  );

export const canonicalConnectorCatalogCompatibilityEvaluationSchema: z.ZodType<CanonicalConnectorCatalogCompatibilityEvaluation> =
  z
    .object({
      filteredAuthMethods: z.array(
        z
          .object({
            connectorSlug: connectorSlugSchema,
            authMethodId: connectorAuthMethodIdSchema,
            reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
          })
          .strict(),
      ),
    })
    .strict();

const LEGACY_EXECUTABLE_CAPABILITY_EVALUATOR_VERSION = 1;
const CANONICAL_EXECUTABLE_CAPABILITY_EVALUATOR_VERSION = 2;

type LegacyConnectorAuthProviderRegistrationCapability = Omit<
  ConnectorAuthProviderRegistrationCapability,
  "connectorSlug"
> & {
  readonly connectorRef: string;
};

export interface ExecutableCapabilityState {
  readonly digest: string;
  readonly configuredNames: ReadonlySet<string>;
  readonly registrations: readonly ConnectorAuthProviderRegistrationCapability[];
}

export interface ExecutableCapabilityStates {
  readonly legacy: ExecutableCapabilityState;
  readonly canonical: ExecutableCapabilityState;
}

interface ExecutableCapabilityConfiguration {
  readonly name: string;
  readonly present: boolean;
}

interface ExecutableCapabilityFacts {
  readonly registrations: readonly ConnectorAuthProviderRegistrationCapability[];
  readonly configuration: readonly ExecutableCapabilityConfiguration[];
  readonly configuredNames: ReadonlySet<string>;
}

interface ConnectorCatalogCompatibilityIdentity {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
}

interface CanonicalSnapshot extends ConnectorCatalogCompatibilityIdentity {
  readonly catalogRawSize: number;
  readonly catalogGzip: Buffer;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function registrationKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function executableCapabilityDigest(args: {
  readonly evaluatorVersion: number;
  readonly registrations:
    | readonly ConnectorAuthProviderRegistrationCapability[]
    | readonly LegacyConnectorAuthProviderRegistrationCapability[];
  readonly configuration: readonly ExecutableCapabilityConfiguration[];
}): string {
  const preimage = JSON.stringify({
    evaluatorVersion: args.evaluatorVersion,
    generic: CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS,
    registrations: args.registrations,
    configuration: args.configuration,
  });
  return `sha256:${createHash("sha256").update(preimage).digest("hex")}`;
}

function legacyRegistrationCapability(
  registration: ConnectorAuthProviderRegistrationCapability,
): LegacyConnectorAuthProviderRegistrationCapability {
  return {
    connectorRef: registration.connectorSlug,
    authMethodId: registration.authMethodId,
    handlers: registration.handlers,
    contract: registration.contract,
    requiredConfigurationNames: registration.requiredConfigurationNames,
  };
}

function connectorCatalogExecutableCapabilityFacts(): ExecutableCapabilityFacts {
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
  const configuredNames = new Set(
    configuration.flatMap(({ name, present }) => {
      return present ? [name] : [];
    }),
  );
  return { registrations, configuration, configuredNames };
}

function createExecutableCapabilityState(args: {
  readonly facts: ExecutableCapabilityFacts;
  readonly evaluatorVersion: number;
  readonly digestRegistrations:
    | readonly ConnectorAuthProviderRegistrationCapability[]
    | readonly LegacyConnectorAuthProviderRegistrationCapability[];
}): ExecutableCapabilityState {
  return {
    digest: executableCapabilityDigest({
      evaluatorVersion: args.evaluatorVersion,
      registrations: args.digestRegistrations,
      configuration: args.facts.configuration,
    }),
    configuredNames: args.facts.configuredNames,
    registrations: args.facts.registrations,
  };
}

export function connectorCatalogExecutableCapabilityStates(): ExecutableCapabilityStates {
  const facts = connectorCatalogExecutableCapabilityFacts();
  return {
    legacy: createExecutableCapabilityState({
      facts,
      evaluatorVersion: LEGACY_EXECUTABLE_CAPABILITY_EVALUATOR_VERSION,
      digestRegistrations: facts.registrations.map(
        legacyRegistrationCapability,
      ),
    }),
    canonical: createExecutableCapabilityState({
      facts,
      evaluatorVersion: CANONICAL_EXECUTABLE_CAPABILITY_EVALUATOR_VERSION,
      digestRegistrations: facts.registrations,
    }),
  };
}

export function connectorCatalogExecutableCapabilityState(): ExecutableCapabilityState {
  const facts = connectorCatalogExecutableCapabilityFacts();
  return createExecutableCapabilityState({
    facts,
    evaluatorVersion: CANONICAL_EXECUTABLE_CAPABILITY_EVALUATOR_VERSION,
    digestRegistrations: facts.registrations,
  });
}

export function connectorCatalogExecutableCapabilityDigest(): string {
  return connectorCatalogExecutableCapabilityState().digest;
}

function methodClientContract(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthProviderMethodContract["client"] {
  const client = method.client;
  if (client === undefined) {
    return { kind: "none" };
  }
  if (client.clientRegistration === "dynamic") {
    return { kind: "dynamic-public" };
  }
  if (client.clientType === "confidential") {
    return "clientIdEnv" in client
      ? {
          kind: "static-confidential-env",
          clientIdEnv: client.clientIdEnv,
          clientSecretEnv: client.clientSecretEnv,
        }
      : { kind: "static-confidential-literal" };
  }
  return { kind: "static-public-literal" };
}

function methodContract(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthProviderMethodContract {
  const grantOutputNames =
    method.grant.kind === "manual"
      ? []
      : Object.keys(method.grant.outputs).sort(compareStrings);
  const startOptionNames =
    method.grant.kind === "device-auth"
      ? method.grant.startOptions
          .map((option) => {
            return option.privateName;
          })
          .sort(compareStrings)
      : [];
  return {
    client: methodClientContract(method),
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
  method: ConnectorCatalogAuthMethod,
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
  readonly method: ConnectorCatalogAuthMethod;
  readonly registration:
    | ConnectorAuthProviderRegistrationCapability
    | undefined;
  readonly configuredNames: ReadonlySet<string>;
}): ConnectorCatalogCompatibilityReason[] {
  const reasons = new Set<ConnectorCatalogCompatibilityReason>();
  addProviderReasons(reasons, args.method, args.registration);

  const contract = methodContract(args.method);
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

function evaluateConnectorCatalogCompatibility(args: {
  readonly artifact: ConnectorCatalogArtifact;
  readonly capability: ExecutableCapabilityState;
}): readonly CanonicalConnectorCatalogFilteredAuthMethod[] {
  const registrations = new Map(
    args.capability.registrations.map((registration) => {
      return [
        registrationKey(registration.connectorSlug, registration.authMethodId),
        registration,
      ];
    }),
  );
  const filtered = args.artifact.connectors.flatMap((connector) => {
    return connector.authMethods.flatMap((method) => {
      const reasons = evaluateMethod({
        method,
        registration: registrations.get(
          registrationKey(connector.slug, method.id),
        ),
        configuredNames: args.capability.configuredNames,
      });
      return reasons.length === 0
        ? []
        : [
            {
              connectorSlug: connector.slug,
              authMethodId: method.id,
              reasons,
            },
          ];
    });
  });
  return filtered.sort((left, right) => {
    return (
      compareStrings(left.connectorSlug, right.connectorSlug) ||
      compareStrings(left.authMethodId, right.authMethodId)
    );
  });
}

async function deleteReplacedEvaluations(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly catalogDigest: string;
}): Promise<void> {
  await args.db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        ne(
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          args.catalogDigest,
        ),
      ),
    );
}

async function persistConnectorCatalogCompatibilityEvaluation(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogCompatibilityIdentity;
  readonly capabilityDigest: string;
  readonly validator: ConnectorCatalogValidatorIdentity;
  readonly evaluatedAt: Date;
  readonly payload: ConnectorCatalogCompatibilityEvaluationPayload;
}): Promise<void> {
  await args.db
    .insert(connectorCatalogCompatibilityEvaluation)
    .values({
      sourceId: args.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.identity.catalogVersion,
      catalogDigest: args.identity.catalogDigest,
      executableCapabilityDigest: args.capabilityDigest,
      catalogValidationBackendVersion: args.validator.backendVersion,
      catalogValidationBuildCommitSha: args.validator.buildCommitSha,
      evaluatedAt: args.evaluatedAt,
      filteredAuthMethods: args.payload,
    })
    .onConflictDoUpdate({
      target: [
        connectorCatalogCompatibilityEvaluation.sourceId,
        connectorCatalogCompatibilityEvaluation.schemaVersion,
        connectorCatalogCompatibilityEvaluation.catalogVersion,
        connectorCatalogCompatibilityEvaluation.catalogDigest,
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      ],
      set: {
        catalogValidationBackendVersion: args.validator.backendVersion,
        catalogValidationBuildCommitSha: args.validator.buildCommitSha,
        evaluatedAt: args.evaluatedAt,
        filteredAuthMethods: args.payload,
      },
      // A draining older API release must not downgrade an attestation written
      // by a newer release during a rolling deployment.
      setWhere: or(
        isNull(
          connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
        ),
        lte(
          sql`string_to_array(${connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion}, '.')::numeric[]`,
          sql`string_to_array(${args.validator.backendVersion}, '.')::numeric[]`,
        ),
      ),
    });
}

export async function persistConnectorCatalogCompatibility(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogCompatibilityIdentity;
  readonly artifact: ConnectorCatalogArtifact;
  readonly capabilities: ExecutableCapabilityStates;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  await deleteReplacedEvaluations({
    db: args.db,
    sourceId: args.sourceId,
    catalogDigest: args.identity.catalogDigest,
  });
  const filteredAuthMethods = evaluateConnectorCatalogCompatibility({
    artifact: args.artifact,
    capability: args.capabilities.canonical,
  });
  const evaluatedAt = nowDate();
  const legacyPayload =
    legacyConnectorCatalogCompatibilityEvaluationSchema.parse(
      filteredAuthMethods.map((method) => {
        return {
          connectorRef: method.connectorSlug,
          authMethodId: method.authMethodId,
          reasons: method.reasons,
        };
      }),
    );
  const canonicalPayload =
    canonicalConnectorCatalogCompatibilityEvaluationSchema.parse({
      filteredAuthMethods,
    });
  await persistConnectorCatalogCompatibilityEvaluation({
    ...args,
    capabilityDigest: args.capabilities.legacy.digest,
    evaluatedAt,
    payload: legacyPayload,
  });
  await persistConnectorCatalogCompatibilityEvaluation({
    ...args,
    capabilityDigest: args.capabilities.canonical.digest,
    evaluatedAt,
    payload: canonicalPayload,
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
): Promise<CanonicalSnapshot | undefined> {
  const [snapshot] = await db
    .select({
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      catalogRawSize: connectorCatalogActiveSnapshot.catalogRawSize,
      catalogGzip: connectorCatalogActiveSnapshot.catalogGzip,
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
  readonly capabilities: ExecutableCapabilityStates;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  const hasState = await lockSyncState(args.db, args.sourceId);
  if (!hasState) {
    return;
  }
  const snapshot = await activeSnapshotForUpdate(args.db, args.sourceId);
  if (snapshot === undefined) {
    return;
  }

  const capabilityStates = [
    args.capabilities.legacy,
    args.capabilities.canonical,
  ];
  const existing = await args.db
    .select({
      executableCapabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
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
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          snapshot.catalogDigest,
        ),
        inArray(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          capabilityStates.map((capability) => {
            return capability.digest;
          }),
        ),
      ),
    );
  const existingByDigest = new Map(
    existing.map((evaluation) => {
      return [evaluation.executableCapabilityDigest, evaluation];
    }),
  );
  const allCurrentOrNewer = capabilityStates.every((capability) => {
    const evaluation = existingByDigest.get(capability.digest);
    return (
      evaluation !== undefined &&
      evaluation.catalogValidationBackendVersion !== null &&
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: {
          backendVersion: evaluation.catalogValidationBackendVersion,
          buildCommitSha: evaluation.catalogValidationBuildCommitSha,
        },
        validator: args.validator,
      })
    );
  });
  if (allCurrentOrNewer) {
    return;
  }

  const decoded = decodeConnectorCatalogSnapshot(snapshot);
  await persistConnectorCatalogCompatibility({
    db: args.db,
    sourceId: args.sourceId,
    identity: snapshot,
    artifact: decoded.artifact,
    capabilities: args.capabilities,
    validator: args.validator,
  });
}

function diagnosticFilteredAuthMethods(
  filteredAuthMethods: readonly CanonicalConnectorCatalogFilteredAuthMethod[],
): ConnectorCatalogFilteredAuthMethod[] {
  return filteredAuthMethods.map((method) => {
    return {
      connectorSlug: method.connectorSlug,
      connectorRef: method.connectorSlug,
      authMethodId: method.authMethodId,
      reasons: [...method.reasons],
    };
  });
}

async function compatibilityStatus(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
  readonly snapshot: ConnectorCatalogCompatibilityIdentity | null;
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
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          args.snapshot.catalogDigest,
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
    filteredAuthMethods: diagnosticFilteredAuthMethods(
      canonicalConnectorCatalogCompatibilityEvaluationSchema.parse(
        result.filteredAuthMethods,
      ).filteredAuthMethods,
    ),
  };
}

export const reconcileConnectorCatalogCompatibility$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const source = connectorCatalogSource();
    const capabilities = connectorCatalogExecutableCapabilityStates();
    const validator = currentConnectorCatalogValidatorIdentity();
    await set(writeDb$).transaction(async (tx) => {
      await reconcileCompatibility({
        db: tx,
        sourceId: source.sourceId,
        capabilities,
        validator,
      });
    });
    signal.throwIfAborted();
  },
);

export const connectorCatalogCompatibilityStatus$ = command(
  async (
    { get },
    snapshot: ConnectorCatalogCompatibilityIdentity | null,
    signal: AbortSignal,
  ): Promise<ConnectorCatalogFilteringStatus> => {
    const source = connectorCatalogSource();
    const capability = connectorCatalogExecutableCapabilityState();
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
