import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import { staticUrlForPublicBrand } from "@okouai/core/public-brand";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogConnection,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogPermissionSummary,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
} from "@okouai/db/schema/connector-catalog";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { onRejection, settle } from "../utils";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
  type ConnectorCatalogAuthMethod,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  connectorCatalogArtifactFailureCode,
  decodeAttestedConnectorCatalogSnapshot,
  decodeConnectorCatalogSnapshot,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import { isConnectorCatalogIconKey } from "@okouai/connectors/connector-catalog/artifacts/icon";
import { deriveConnectorCatalogFirewallPermissions } from "@okouai/connectors/connector-catalog/artifacts/relationships";
import {
  connectorCatalogCompatibilityEvaluationSchema,
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import type { ConnectorCatalogLoadTiming } from "./connector-catalog-load-timing.service";
import { connectorCatalogSource } from "./connector-catalog-source";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
} from "./connector-catalog-validator-authority";
import type { ApiDispatchTimingActionType } from "./api-dispatch-timing.service";
import { connectorAuthMethodFeatureSwitch } from "./connector-auth-method-feature-switches";
import {
  CONNECTOR_DISCOVERY_LIMIT,
  FEATURED_CONNECTOR_SLUGS,
} from "./connector-catalog-featured";
import type { ConnectorCatalogConnection } from "./connector-catalog-connection";

const log = logger("connector-catalog:reader");
const CONNECTOR_CATALOG_ICON_BASE_URL = "https://static.vm0.io/";

export interface ExternalCatalogIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

interface PrivateAuthMethodFacts {
  readonly requestedScopes: readonly string[];
  readonly supportsRefresh: boolean;
}

export interface AcceptedConnectorCatalogSnapshot {
  readonly identity: ExternalCatalogIdentity;
  readonly catalogRawSize: number;
  readonly catalogCompressedSize: number;
  readonly artifact: ConnectorCatalogArtifact;
  readonly connectorBySlug: ReadonlyMap<
    string,
    ConnectorCatalogArtifactConnector
  >;
  readonly privateMethodFacts: ReadonlyMap<string, PrivateAuthMethodFacts>;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

interface PreparedExternalCatalogCache {
  completed:
    | {
        readonly key: string;
        readonly catalog: AcceptedConnectorCatalogSnapshot;
      }
    | undefined;
  readonly inFlight: Map<
    string,
    Promise<AcceptedConnectorCatalogSnapshot | undefined>
  >;
}

interface EffectiveConnector {
  readonly connector: ConnectorCatalogArtifactConnector;
  readonly authMethods: readonly ConnectorCatalogAuthMethod[];
}

interface ExternalCatalogReadArgs {
  readonly db: ReadonlyDb;
  readonly featureStates: ConnectorFeatureStates;
}

interface ExternalBrandedCatalogReadArgs extends ExternalCatalogReadArgs {
  readonly publicBrand: PublicBrand;
}

interface ExternalCatalogConnectorReadArgs extends ExternalBrandedCatalogReadArgs {
  readonly connectorSlug: string;
}

interface ExternalCatalogConnectorStatusReadArgs extends ExternalCatalogConnectorReadArgs {
  readonly connections: readonly ConnectorCatalogConnection[];
}

interface ExternalCatalogSearchArgs extends ExternalCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ExternalCatalogStatusArgs extends ExternalBrandedCatalogReadArgs {
  readonly connections: readonly ConnectorCatalogConnection[];
  readonly referenceConnectorSlugs: readonly string[];
}

interface ExternalCatalogDiscoveryArgs extends ExternalCatalogStatusArgs {
  readonly keyword: string | undefined;
}

export interface ConnectorCatalogReferenceMetadata {
  readonly connectorSlug: string;
  readonly label: string;
  readonly icon: PublicConnectorCatalogIcon;
}

export interface ConnectorCatalogStatusRead {
  readonly status: PublicConnectorCatalogStatusResponse;
  readonly referenceMetadata: readonly ConnectorCatalogReferenceMetadata[];
}

interface ConnectorCatalogDiscoveryRead {
  readonly status: PublicConnectorCatalogDiscoveryResponse;
  readonly referenceMetadata: readonly ConnectorCatalogReferenceMetadata[];
}

export class ExternalConnectorCatalogUnavailableError extends Error {
  constructor() {
    super("Accepted external connector catalog is unavailable");
    this.name = "ExternalConnectorCatalogUnavailableError";
  }
}

const preparedCatalogCache = singleton((): PreparedExternalCatalogCache => {
  return {
    completed: undefined,
    inFlight: new Map<string, Promise<AcceptedConnectorCatalogSnapshot>>(),
  };
});

function authMethodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function identityKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

function identityLogFields(identity: ExternalCatalogIdentity) {
  return {
    sourceId: identity.sourceId,
    schemaVersion: identity.schemaVersion,
    catalogVersion: identity.catalogVersion,
    catalogDigest: identity.catalogDigest,
    capabilityDigest: identity.capabilityDigest,
  };
}

function persistedCatalogValidationAuthority(args: {
  readonly backendVersion: string | null;
  readonly validationRevision: string | null;
}): ConnectorCatalogValidationAuthority | null {
  return args.backendVersion === null
    ? null
    : {
        validatorVersion: args.backendVersion,
        buildCommitSha: args.validationRevision,
      };
}

function requestedScopes(
  method: ConnectorCatalogAuthMethod,
): readonly string[] {
  switch (method.grant.kind) {
    case "auth-code":
    case "device-auth":
    case "external-code": {
      return method.grant.scopes;
    }
    case "manual":
    case "openid-auth": {
      return [];
    }
  }
}

function privateMethodFacts(
  artifact: ConnectorCatalogArtifact,
): ReadonlyMap<string, PrivateAuthMethodFacts> {
  const facts = new Map<string, PrivateAuthMethodFacts>();
  for (const connector of artifact.connectors) {
    for (const method of connector.authMethods) {
      facts.set(authMethodKey(connector.slug, method.id), {
        requestedScopes: [...requestedScopes(method)],
        supportsRefresh: method.access.kind === "refresh-token",
      });
    }
  }
  return facts;
}

async function measureCatalogLoad<T>(
  timing: ConnectorCatalogLoadTiming | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T | Promise<T>,
): Promise<T> {
  return timing
    ? await timing.measure(actionType, operation)
    : await operation();
}

function measureCatalogLoadSync<T>(
  timing: ConnectorCatalogLoadTiming | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T,
): T {
  return timing ? timing.measureSync(actionType, operation) : operation();
}

function externalCatalogJoin(capabilityDigest: string) {
  return and(
    eq(
      connectorCatalogCompatibilityEvaluation.sourceId,
      connectorCatalogActiveSnapshot.sourceId,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.schemaVersion,
      connectorCatalogActiveSnapshot.schemaVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogVersion,
      connectorCatalogActiveSnapshot.catalogVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogDigest,
      connectorCatalogActiveSnapshot.catalogDigest,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      capabilityDigest,
    ),
  );
}

async function readCurrentIdentity(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<ExternalCatalogIdentity | undefined> {
  const [row] = await measureCatalogLoad(
    args.timing,
    "api_dispatch_connector_catalog_query_identity",
    async () => {
      return await args.db
        .select({
          schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
          catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
          catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
        })
        .from(connectorCatalogActiveSnapshot)
        .where(
          and(
            eq(connectorCatalogActiveSnapshot.sourceId, args.sourceId),
            eq(
              connectorCatalogActiveSnapshot.schemaVersion,
              SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            ),
          ),
        )
        .limit(1);
    },
  );
  return row
    ? {
        sourceId: args.sourceId,
        schemaVersion: row.schemaVersion,
        catalogVersion: row.catalogVersion,
        catalogDigest: row.catalogDigest,
        capabilityDigest: args.capabilityDigest,
      }
    : undefined;
}

async function readCurrentCatalogPayload(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly timing?: ConnectorCatalogLoadTiming;
}) {
  const [row] = await measureCatalogLoad(
    args.timing,
    "api_dispatch_connector_catalog_query_payload",
    async () => {
      return await args.db
        .select({
          catalogRawSize: connectorCatalogActiveSnapshot.catalogRawSize,
          catalogGzip: connectorCatalogActiveSnapshot.catalogGzip,
          catalogValidationBackendVersion:
            connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
          catalogValidationBuildCommitSha:
            connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
          executableCapabilityDigest:
            connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          filteredAuthMethods:
            connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
        })
        .from(connectorCatalogActiveSnapshot)
        .leftJoin(
          connectorCatalogCompatibilityEvaluation,
          externalCatalogJoin(args.identity.capabilityDigest),
        )
        .where(
          and(
            eq(connectorCatalogActiveSnapshot.sourceId, args.identity.sourceId),
            eq(
              connectorCatalogActiveSnapshot.schemaVersion,
              args.identity.schemaVersion,
            ),
            eq(
              connectorCatalogActiveSnapshot.catalogVersion,
              args.identity.catalogVersion,
            ),
            eq(
              connectorCatalogActiveSnapshot.catalogDigest,
              args.identity.catalogDigest,
            ),
          ),
        )
        .limit(1);
    },
  );
  return row;
}

async function readCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly capability: ExecutableCapabilityState;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<AcceptedConnectorCatalogSnapshot | undefined> {
  const row = await readCurrentCatalogPayload(args);
  if (!row) {
    return undefined;
  }

  const decodeArgs = {
    catalogGzip: row.catalogGzip,
    catalogRawSize: row.catalogRawSize,
    catalogVersion: args.identity.catalogVersion,
    catalogDigest: args.identity.catalogDigest,
    ...(args.timing === undefined ? {} : { timing: args.timing }),
  };
  const validationAuthority = persistedCatalogValidationAuthority({
    backendVersion: row.catalogValidationBackendVersion,
    validationRevision: row.catalogValidationBuildCommitSha,
  });
  const compatibilityEvaluationExists = row.executableCapabilityDigest !== null;
  const validationAuthorityIsCurrent =
    compatibilityEvaluationExists &&
    validationAuthority !== null &&
    connectorCatalogValidationAuthorityIsCurrent({
      authority: validationAuthority,
      validator: currentConnectorCatalogValidatorIdentity(),
    });
  if (validationAuthorityIsCurrent) {
    args.timing?.recordValidationResult({ outcome: "attested" });
  } else {
    args.timing?.recordValidationResult({
      outcome: "full_fallback",
      fallbackReason: !compatibilityEvaluationExists
        ? "missing_compatibility"
        : validationAuthority === null
          ? "missing_authority"
          : "different_authority",
    });
  }
  const decoded = validationAuthorityIsCurrent
    ? decodeAttestedConnectorCatalogSnapshot(decodeArgs)
    : decodeConnectorCatalogSnapshot(decodeArgs);
  const filteredAuthMethods = measureCatalogLoadSync(
    args.timing,
    "api_dispatch_connector_catalog_validate_compatibility",
    () => {
      if (!validationAuthorityIsCurrent) {
        return evaluateConnectorCatalogCompatibility({
          artifact: decoded.artifact,
          capability: args.capability,
        });
      }
      const parsed = connectorCatalogCompatibilityEvaluationSchema.safeParse(
        row.filteredAuthMethods,
      );
      if (!parsed.success) {
        log.error(
          "Rejected persisted connector catalog compatibility evaluation",
          {
            ...identityLogFields(args.identity),
            failureCode: "invalid-compatibility-evaluation",
          },
        );
        throw new ExternalConnectorCatalogUnavailableError();
      }
      return parsed.data.filteredAuthMethods;
    },
  );
  const artifact = decoded.artifact;

  return measureCatalogLoadSync(
    args.timing,
    "api_dispatch_connector_catalog_materialize_accepted_snapshot",
    () => {
      return {
        identity: args.identity,
        catalogRawSize: row.catalogRawSize,
        catalogCompressedSize: row.catalogGzip.byteLength,
        artifact,
        connectorBySlug: new Map(
          artifact.connectors.map((connector) => {
            return [connector.slug, connector];
          }),
        ),
        privateMethodFacts: privateMethodFacts(artifact),
        filteredMethodKeys: new Set(
          filteredAuthMethods.map((filtered) => {
            return authMethodKey(filtered.connectorSlug, filtered.authMethodId);
          }),
        ),
      };
    },
  );
}

async function loadCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly capability: ExecutableCapabilityState;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<AcceptedConnectorCatalogSnapshot | undefined> {
  const result = await settle(readCurrentCatalog(args));
  if (result.ok) {
    return result.value;
  }

  const failureCode = connectorCatalogArtifactFailureCode(result.error);
  if (failureCode === undefined) {
    throw result.error;
  }
  log.error("Rejected persisted connector catalog snapshot", {
    ...identityLogFields(args.identity),
    failureCode,
  });
  throw new ExternalConnectorCatalogUnavailableError();
}

function deleteInFlightCatalog(
  cache: PreparedExternalCatalogCache,
  key: string,
  promise: Promise<AcceptedConnectorCatalogSnapshot | undefined>,
): void {
  if (cache.inFlight.get(key) === promise) {
    cache.inFlight.delete(key);
  }
}

async function loadAcceptedConnectorCatalogSnapshotAttempt(
  db: ReadonlyDb,
  timing: ConnectorCatalogLoadTiming | undefined,
): Promise<AcceptedConnectorCatalogSnapshot | undefined> {
  const sourceId = connectorCatalogSource().sourceId;
  const capability = connectorCatalogExecutableCapabilityState();
  const currentIdentity = await readCurrentIdentity({
    db,
    sourceId,
    capabilityDigest: capability.digest,
    ...(timing === undefined ? {} : { timing }),
  });
  if (!currentIdentity) {
    throw new ExternalConnectorCatalogUnavailableError();
  }
  const currentKey = identityKey(currentIdentity);
  const cache = preparedCatalogCache();
  if (cache.completed?.key === currentKey) {
    timing?.recordAcceptedCacheOutcome("hit");
    timing?.recordValidationResult({ outcome: "not_run" });
    return cache.completed.catalog;
  }

  const existing = cache.inFlight.get(currentKey);
  if (existing) {
    timing?.recordAcceptedCacheOutcome("in_flight");
    timing?.recordValidationResult({ outcome: "not_run" });
    return await existing;
  }

  const completedIdentity = cache.completed?.catalog.identity;
  timing?.recordAcceptedCacheMissReason(
    completedIdentity === undefined
      ? "process_empty"
      : completedIdentity.sourceId !== currentIdentity.sourceId ||
          completedIdentity.schemaVersion !== currentIdentity.schemaVersion ||
          completedIdentity.catalogVersion !== currentIdentity.catalogVersion ||
          completedIdentity.catalogDigest !== currentIdentity.catalogDigest
        ? "catalog_identity_changed"
        : "capability_identity_changed",
  );
  timing?.recordAcceptedCacheOutcome("miss");
  const promise = loadCurrentCatalog({
    db,
    identity: currentIdentity,
    capability,
    ...(timing === undefined ? {} : { timing }),
  });
  cache.inFlight.set(currentKey, promise);
  const catalog = await onRejection(promise, () => {
    deleteInFlightCatalog(cache, currentKey, promise);
  });
  deleteInFlightCatalog(cache, currentKey, promise);
  if (!catalog) {
    return undefined;
  }
  cache.completed = { key: currentKey, catalog };
  return catalog;
}

export async function loadAcceptedConnectorCatalogSnapshot(
  db: ReadonlyDb,
  timing?: ConnectorCatalogLoadTiming,
): Promise<AcceptedConnectorCatalogSnapshot> {
  const first = await loadAcceptedConnectorCatalogSnapshotAttempt(db, timing);
  if (first) {
    return first;
  }

  // The active row is intentionally the only durable catalog snapshot. If an
  // activation commits between the identity and payload queries, the old
  // identity no longer has a row; retry once against the newly active identity.
  const second = await loadAcceptedConnectorCatalogSnapshotAttempt(db, timing);
  if (!second) {
    throw new ExternalConnectorCatalogUnavailableError();
  }
  return second;
}

/**
 * Applies rollout policy to discovery projections only. Feature switches must
 * never be reused as connector authorization or execution checks;
 * ConnectorActionResolver intentionally does not read them.
 */
function featureSwitchEnabled(
  connectorSlug: string,
  authMethodId: string,
  featureStates: ConnectorFeatureStates,
): boolean {
  const featureSwitch = connectorAuthMethodFeatureSwitch(
    connectorSlug,
    authMethodId,
  );
  return featureSwitch === undefined || featureStates?.[featureSwitch] === true;
}

function effectiveConnectors(args: {
  readonly catalog: AcceptedConnectorCatalogSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly EffectiveConnector[] {
  return args.catalog.artifact.connectors.flatMap((connector) => {
    const authMethods = connector.authMethods.filter((method) => {
      if (
        args.catalog.filteredMethodKeys.has(
          authMethodKey(connector.slug, method.id),
        )
      ) {
        return false;
      }
      if (!method.visible) {
        return false;
      }
      if (
        !featureSwitchEnabled(connector.slug, method.id, args.featureStates)
      ) {
        return false;
      }
      return true;
    });
    if (authMethods.length === 0) {
      return [];
    }
    return [{ connector, authMethods }];
  });
}

function iconForCatalog(
  connector: ConnectorCatalogArtifactConnector,
  publicBrand: PublicBrand,
): PublicConnectorCatalogIcon {
  const key = connector.icon.key;
  if (!isConnectorCatalogIconKey(key)) {
    throw new Error(`Invalid connector catalog icon key "${key}"`);
  }
  return {
    url: staticUrlForPublicBrand(
      `${CONNECTOR_CATALOG_ICON_BASE_URL}${key}`,
      publicBrand,
    ),
    invertInDarkMode: connector.icon.invertInDarkMode,
    ...(connector.icon.scale === undefined
      ? {}
      : { scale: connector.icon.scale }),
  };
}

function referenceMetadataForCatalog(
  catalog: AcceptedConnectorCatalogSnapshot,
  connectorSlugs: readonly string[],
  publicBrand: PublicBrand,
): readonly ConnectorCatalogReferenceMetadata[] {
  const requestedSlugs = new Set(connectorSlugs);
  return catalog.artifact.connectors.flatMap((connector) => {
    return requestedSlugs.has(connector.slug)
      ? [
          {
            connectorSlug: connector.slug,
            label: connector.label,
            icon: iconForCatalog(connector, publicBrand),
          },
        ]
      : [];
  });
}

function permissionSummaryForCatalog(
  connector: ConnectorCatalogArtifactConnector,
): PublicConnectorCatalogPermissionSummary {
  if (connector.firewall.kind === "none") {
    return {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    };
  }
  const permissionCount = deriveConnectorCatalogFirewallPermissions(
    connector.firewall.config.apis,
  ).length;
  const defaultPolicy = compactDefaultPolicy(connector);
  return {
    hasPermissions: permissionCount > 0,
    permissionCount,
    hasCategories: connector.firewall.categories !== null,
    hasDefaultPolicyOverrides:
      defaultPolicy.permissionDefault !== "allow" ||
      defaultPolicy.unknownPolicy !== "allow" ||
      defaultPolicy.permissionOverrides !== undefined,
  };
}

function authMethodSummaryForCatalog(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: method.id,
    label: method.label,
    description: method.description,
    grantKind: method.grant.kind,
  };
}

function authMethodDetailForCatalog(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(method),
    manualFields:
      method.grant.kind === "manual"
        ? method.grant.fields.map((field) => {
            return {
              id: field.publicId,
              label: field.label,
              required: field.required,
              placeholder: field.placeholder,
              inputType: field.storage === "variable" ? "text" : "password",
            };
          })
        : [],
    startOptions:
      method.grant.kind === "device-auth"
        ? method.grant.startOptions.map((option) => {
            return {
              id: option.publicId,
              kind: option.kind,
              label: option.label,
              required: option.required,
              defaultValue: option.defaultValue,
              options: option.options.map((choice) => {
                return { ...choice };
              }),
            };
          })
        : [],
  };
}

function connectorCatalogItem(
  effective: EffectiveConnector,
  publicBrand: PublicBrand,
): PublicConnectorCatalogItem {
  return {
    slug: effective.connector.slug,
    label: effective.connector.label,
    description: effective.connector.description,
    icon: iconForCatalog(effective.connector, publicBrand),
    category: effective.connector.category,
    generation: [...effective.connector.generation],
    tags: [...effective.connector.tags],
    authMethods: effective.authMethods.map(authMethodSummaryForCatalog),
    permissionSummary: permissionSummaryForCatalog(effective.connector),
  };
}

function connectorCatalogDetail(
  effective: EffectiveConnector,
  publicBrand: PublicBrand,
): PublicConnectorCatalogDetail {
  return {
    ...connectorCatalogItem(effective, publicBrand),
    authMethods: effective.authMethods.map(authMethodDetailForCatalog),
  };
}

export function getConnectorCatalogResolutionDetail(
  connector: ConnectorCatalogArtifactConnector,
): PublicConnectorCatalogDetail {
  return connectorCatalogDetail(
    {
      connector,
      authMethods: connector.authMethods,
    },
    "vm0",
  );
}

export function listAcceptedConnectorCatalogAvailableSlugs(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorSlug[] {
  return effectiveConnectors({
    catalog: args.snapshot,
    featureStates: args.featureStates,
  })
    .map((entry) => {
      return entry.connector.slug;
    })
    .sort();
}

function categoryMetadataForConnectors(
  catalog: AcceptedConnectorCatalogSnapshot,
  connectors: readonly EffectiveConnector[],
): PublicConnectorCatalogListResponse["categoryMetadata"] {
  const visibleCategories = new Set(
    connectors.map((effective) => {
      return effective.connector.category;
    }),
  );
  const categories = catalog.artifact.categoryMetadata.categories.filter(
    (category) => {
      return visibleCategories.has(category.id);
    },
  );
  const visibleGroups = new Set(
    categories.flatMap((category) => {
      return category.groupId === null ? [] : [category.groupId];
    }),
  );
  return {
    categories: categories.map((category) => {
      return { ...category };
    }),
    groups: catalog.artifact.categoryMetadata.groups
      .filter((group) => {
        return visibleGroups.has(group.id);
      })
      .map((group) => {
        return { ...group };
      }),
  };
}

function connectionForCatalogStatus(
  connector: ConnectorResponse | null,
): PublicConnectorCatalogConnection | null {
  if (!connector) {
    return null;
  }
  return {
    id: connector.id,
    authMethod: connector.authMethod,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    reconnectReason: connector.reconnectReason,
  };
}

function hasRequestedScopes(
  requested: readonly string[],
  stored: readonly string[] | null,
): boolean {
  if (requested.length === 0) {
    return true;
  }
  if (!stored) {
    return false;
  }
  const storedScopes = new Set(stored);
  return requested.every((scope) => {
    return storedScopes.has(scope);
  });
}

function hasCatalogScopeMismatch(args: {
  readonly connector: ConnectorResponse | null;
  readonly facts: PrivateAuthMethodFacts | undefined;
  readonly storedRequestedScopes: readonly string[] | null;
}): boolean {
  if (args.connector === null || args.facts === undefined) {
    return false;
  }
  return !hasRequestedScopes(
    args.facts.requestedScopes,
    args.storedRequestedScopes,
  );
}

function connectorCatalogStatusItem(args: {
  readonly catalog: AcceptedConnectorCatalogSnapshot;
  readonly effective: EffectiveConnector;
  readonly connection: ConnectorCatalogConnection | null;
  readonly publicBrand: PublicBrand;
}): PublicConnectorCatalogStatusItem {
  const detail = connectorCatalogDetail(args.effective, args.publicBrand);
  const response = args.connection?.response ?? null;
  const effectiveMethod = response
    ? args.effective.authMethods.find((method) => {
        return method.id === response.authMethod;
      })
    : undefined;
  const connector = effectiveMethod ? response : null;
  const facts = effectiveMethod
    ? args.catalog.privateMethodFacts.get(
        authMethodKey(args.effective.connector.slug, effectiveMethod.id),
      )
    : undefined;
  if (effectiveMethod && !facts) {
    throw new Error("Connector catalog private method facts are missing");
  }
  const scopeMismatch = hasCatalogScopeMismatch({
    connector,
    facts,
    storedRequestedScopes: args.connection?.oauthRequestedScopes ?? null,
  });
  let connectionStatus: PublicConnectorCatalogConnectionStatus =
    "not-connected";
  if (connector !== null) {
    connectionStatus =
      connector.connectionStatus === "reconnect-required"
        ? "reconnect-required"
        : scopeMismatch
          ? "scope-mismatch"
          : "connected";
  }
  const [singleMethod] = args.effective.authMethods;

  return {
    ...detail,
    connection: connectionForCatalogStatus(connector),
    connected: connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      connector !== null && facts?.supportsRefresh === true,
    tokenExpiresAt: connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId:
      args.effective.authMethods.length === 1 &&
      singleMethod?.grant.kind === "auth-code"
        ? singleMethod.id
        : null,
    connectNotice: null,
  };
}

function choosePermissionDefault(args: {
  readonly permissions: readonly string[];
  readonly defaultAllowed: readonly string[] | null;
}): "allow" | "deny" {
  if (args.defaultAllowed === null) {
    return "allow";
  }
  const allowed = new Set(args.defaultAllowed);
  const allowCount = args.permissions.filter((permission) => {
    return allowed.has(permission);
  }).length;
  return args.permissions.length - allowCount > allowCount ? "deny" : "allow";
}

function compactDefaultPolicy(
  connector: ConnectorCatalogArtifactConnector,
): PublicConnectorCatalogPermissionDetail["defaultPolicy"] {
  if (connector.firewall.kind === "none") {
    throw new Error("Connector catalog firewall metadata is unavailable");
  }
  const permissionNames = deriveConnectorCatalogFirewallPermissions(
    connector.firewall.config.apis,
  ).map((permission) => {
    return permission.name;
  });
  const permissionDefault = choosePermissionDefault({
    permissions: permissionNames,
    defaultAllowed: connector.firewall.defaultAllowed,
  });
  const allowed =
    connector.firewall.defaultAllowed === null
      ? new Set(permissionNames)
      : new Set(connector.firewall.defaultAllowed);
  const overrides = permissionNames.filter((permission) => {
    return allowed.has(permission) !== (permissionDefault === "allow");
  });
  const overrideValue = permissionDefault === "allow" ? "deny" : "allow";
  return {
    permissionDefault,
    ...(overrides.length === 0
      ? {}
      : { permissionOverrides: { [overrideValue]: overrides } }),
    unknownPolicy: connector.firewall.defaultUnknownPolicy,
  };
}

export async function listExternalPublicConnectorCatalog(
  args: ExternalBrandedCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const connectors = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  return {
    connectors: connectors.map((connector) => {
      return connectorCatalogItem(connector, args.publicBrand);
    }),
    categoryMetadata: categoryMetadataForConnectors(catalog, connectors),
  };
}

function connectorMatchesKeyword(
  entry: EffectiveConnector,
  keyword: string,
): boolean {
  return (
    entry.connector.slug.toLowerCase().includes(keyword) ||
    entry.connector.label.toLowerCase().includes(keyword)
  );
}

function featuredEffectiveConnectors(
  effective: readonly EffectiveConnector[],
): EffectiveConnector[] {
  const bySlug = new Map(
    effective.map((entry) => {
      return [entry.connector.slug, entry];
    }),
  );
  const featured = FEATURED_CONNECTOR_SLUGS.flatMap((slug) => {
    const entry = bySlug.get(slug);
    return entry ? [entry] : [];
  });
  const selectedSlugs = new Set(
    featured.map((entry) => {
      return entry.connector.slug;
    }),
  );
  for (const entry of effective) {
    if (featured.length >= CONNECTOR_DISCOVERY_LIMIT) {
      break;
    }
    if (!selectedSlugs.has(entry.connector.slug)) {
      featured.push(entry);
      selectedSlugs.add(entry.connector.slug);
    }
  }
  return featured;
}

function searchEffectiveConnectors(
  effective: readonly EffectiveConnector[],
  keyword: string | undefined,
): EffectiveConnector[] {
  const normalizedKeyword = keyword?.trim().toLowerCase();
  if (!normalizedKeyword) {
    return featuredEffectiveConnectors(effective);
  }
  return effective
    .filter((entry) => {
      return connectorMatchesKeyword(entry, normalizedKeyword);
    })
    .slice(0, CONNECTOR_DISCOVERY_LIMIT);
}

function discoveryEffectiveConnectors(
  effective: readonly EffectiveConnector[],
  args: Pick<ExternalCatalogDiscoveryArgs, "connections" | "keyword">,
): EffectiveConnector[] {
  if (args.keyword?.trim()) {
    return searchEffectiveConnectors(effective, args.keyword);
  }
  const connectedSlugs = new Set(
    args.connections.map((connection) => {
      return connection.response.slug;
    }),
  );
  const connected = effective.filter((entry) => {
    return connectedSlugs.has(entry.connector.slug);
  });
  return [
    ...connected,
    ...featuredEffectiveConnectors(effective).filter((entry) => {
      return !connectedSlugs.has(entry.connector.slug);
    }),
  ];
}

export async function searchExternalConnectorCatalog(
  args: ExternalCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  return searchEffectiveConnectors(effective, args.keyword).map((entry) => {
    const connector = entry.connector;
    return {
      slug: connector.slug,
      label: connector.label,
      description: connector.description,
      authMethods: entry.authMethods.map((method) => {
        return method.id;
      }),
    };
  });
}

export async function getExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogConnectorStatusReadArgs,
): Promise<PublicConnectorCatalogStatusItem | null> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const entry = effective.find((connector) => {
    return connector.connector.slug === args.connectorSlug;
  });
  if (!entry) {
    return null;
  }
  const connection = args.connections.find((candidate) => {
    return candidate.response.slug === args.connectorSlug;
  });
  return connectorCatalogStatusItem({
    catalog,
    effective: entry,
    connection: connection ?? null,
    publicBrand: args.publicBrand,
  });
}

export async function listExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogStatusArgs,
): Promise<ConnectorCatalogStatusRead> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  return connectorCatalogStatusRead({
    catalog,
    effective,
    connections: args.connections,
    referenceConnectorSlugs: args.referenceConnectorSlugs,
    publicBrand: args.publicBrand,
  });
}

export async function discoverExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogDiscoveryArgs,
): Promise<ConnectorCatalogDiscoveryRead> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const read = connectorCatalogStatusRead({
    catalog,
    effective: discoveryEffectiveConnectors(effective, args),
    connections: args.connections,
    referenceConnectorSlugs: args.referenceConnectorSlugs,
    publicBrand: args.publicBrand,
  });
  return {
    ...read,
    status: {
      ...read.status,
      totalConnectorCount: effective.length,
    },
  };
}

function connectorCatalogStatusRead(args: {
  readonly catalog: AcceptedConnectorCatalogSnapshot;
  readonly effective: readonly EffectiveConnector[];
  readonly connections: readonly ConnectorCatalogConnection[];
  readonly referenceConnectorSlugs: readonly string[];
  readonly publicBrand: PublicBrand;
}): ConnectorCatalogStatusRead {
  const connectionsBySlug = new Map(
    args.connections.map((connection) => {
      return [connection.response.slug, connection];
    }),
  );
  const connectors = args.effective.map((entry) => {
    return connectorCatalogStatusItem({
      catalog: args.catalog,
      effective: entry,
      connection: connectionsBySlug.get(entry.connector.slug) ?? null,
      publicBrand: args.publicBrand,
    });
  });
  return {
    status: {
      connectors,
      categoryMetadata: categoryMetadataForConnectors(
        args.catalog,
        args.effective,
      ),
    },
    referenceMetadata: referenceMetadataForCatalog(
      args.catalog,
      args.referenceConnectorSlugs,
      args.publicBrand,
    ),
  };
}

export async function getExternalPublicConnectorCatalogPermissionDetail(
  args: ExternalCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const entry = effective.find((connector) => {
    return connector.connector.slug === args.connectorSlug;
  });
  if (!entry || entry.connector.firewall.kind === "none") {
    return null;
  }
  const firewall = entry.connector.firewall;
  const permissions = deriveConnectorCatalogFirewallPermissions(
    firewall.config.apis,
  );
  return {
    connectorSlug: entry.connector.slug,
    label: entry.connector.label,
    icon: iconForCatalog(entry.connector, args.publicBrand),
    permissionCount: permissions.length,
    permissions: permissions.map((permission) => {
      return { ...permission };
    }),
    categories:
      firewall.categories === null
        ? null
        : {
            categories: { ...firewall.categories.byPermission },
            displayOrder: [...firewall.categories.displayOrder],
          },
    defaultPolicy: compactDefaultPolicy(entry.connector),
  };
}
