import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogConnection,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogDetail,
  PublicConnectorCatalogIcon,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogPermissionSummary,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
} from "@vm0/db/schema/connector-catalog";
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
} from "./connector-catalog-artifacts/artifacts";
import {
  connectorCatalogArtifactFailureCode,
  decodeAttestedConnectorCatalogSnapshot,
  decodeConnectorCatalogSnapshot,
} from "./connector-catalog-artifacts/loader";
import { connectorCatalogIconUrl } from "./connector-catalog-artifacts/icon";
import { deriveConnectorCatalogFirewallPermissions } from "./connector-catalog-artifacts/relationships";
import {
  connectorCatalogExecutableCapabilityDigest,
  legacyConnectorCatalogCompatibilityEvaluationSchema,
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

const log = logger("connector-catalog:reader");

export interface ExternalCatalogIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

interface PrivateAuthMethodFacts {
  readonly requiredScopes: readonly string[];
  readonly supportsRefresh: boolean;
}

export interface AcceptedConnectorCatalogSnapshot {
  readonly identity: ExternalCatalogIdentity;
  readonly catalogRawSize: number;
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

interface ExternalCatalogConnectorReadArgs extends ExternalCatalogReadArgs {
  readonly connectorSlug: string;
}

interface ExternalCatalogSearchArgs extends ExternalCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ExternalCatalogStatusArgs extends ExternalCatalogReadArgs {
  readonly connectors: readonly ConnectorResponse[];
  readonly referenceConnectorSlugs: readonly string[];
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
  readonly buildCommitSha: string | null;
}): ConnectorCatalogValidationAuthority | null {
  return args.backendVersion === null
    ? null
    : {
        backendVersion: args.backendVersion,
        buildCommitSha: args.buildCommitSha,
      };
}

function isRecognizedFeatureSwitchKey(
  value: string,
): value is FeatureSwitchKey {
  return Object.values(FeatureSwitchKey).some((key) => {
    return key === value;
  });
}

function requiredScopes(method: ConnectorCatalogAuthMethod): readonly string[] {
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
        requiredScopes: [...requiredScopes(method)],
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

function externalCatalogJoin() {
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
        .innerJoin(
          connectorCatalogCompatibilityEvaluation,
          externalCatalogJoin(),
        )
        .where(
          and(
            eq(connectorCatalogActiveSnapshot.sourceId, args.sourceId),
            eq(
              connectorCatalogActiveSnapshot.schemaVersion,
              SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            ),
            eq(
              connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
              args.capabilityDigest,
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

async function readCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<AcceptedConnectorCatalogSnapshot | undefined> {
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
          filteredAuthMethods:
            connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
        })
        .from(connectorCatalogActiveSnapshot)
        .innerJoin(
          connectorCatalogCompatibilityEvaluation,
          externalCatalogJoin(),
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
            eq(
              connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
              args.identity.capabilityDigest,
            ),
          ),
        )
        .limit(1);
    },
  );
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
    buildCommitSha: row.catalogValidationBuildCommitSha,
  });
  const validationAuthorityIsCurrent =
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
      fallbackReason:
        validationAuthority === null
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
      const parsed =
        legacyConnectorCatalogCompatibilityEvaluationSchema.safeParse(
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
      return parsed.data;
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
        artifact,
        connectorBySlug: new Map(
          artifact.connectors.map((connector) => {
            return [connector.slug, connector];
          }),
        ),
        privateMethodFacts: privateMethodFacts(artifact),
        filteredMethodKeys: new Set(
          filteredAuthMethods.map((filtered) => {
            return authMethodKey(filtered.connectorRef, filtered.authMethodId);
          }),
        ),
      };
    },
  );
}

async function loadCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
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
  const capabilityDigest = connectorCatalogExecutableCapabilityDigest();
  const currentIdentity = await readCurrentIdentity({
    db,
    sourceId,
    capabilityDigest,
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

  timing?.recordAcceptedCacheOutcome("miss");
  const promise = loadCurrentCatalog({
    db,
    identity: currentIdentity,
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
  method: ConnectorCatalogAuthMethod,
  featureStates: ConnectorFeatureStates,
): boolean {
  if (method.featureSwitch === null) {
    return true;
  }
  return (
    isRecognizedFeatureSwitchKey(method.featureSwitch) &&
    featureStates?.[method.featureSwitch] === true
  );
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
      if (!featureSwitchEnabled(method, args.featureStates)) {
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
): PublicConnectorCatalogIcon {
  return {
    url: connectorCatalogIconUrl(connector.icon.key),
    invertInDarkMode: connector.icon.invertInDarkMode,
    ...(connector.icon.scale === undefined
      ? {}
      : { scale: connector.icon.scale }),
  };
}

function referenceMetadataForCatalog(
  catalog: AcceptedConnectorCatalogSnapshot,
  connectorSlugs: readonly string[],
): readonly ConnectorCatalogReferenceMetadata[] {
  const requestedSlugs = new Set(connectorSlugs);
  return catalog.artifact.connectors.flatMap((connector) => {
    return requestedSlugs.has(connector.slug)
      ? [
          {
            connectorSlug: connector.slug,
            label: connector.label,
            icon: iconForCatalog(connector),
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
): PublicConnectorCatalogItem {
  return {
    slug: effective.connector.slug,
    label: effective.connector.label,
    description: effective.connector.description,
    icon: iconForCatalog(effective.connector),
    category: effective.connector.category,
    generation: [...effective.connector.generation],
    tags: [...effective.connector.tags],
    authMethods: effective.authMethods.map(authMethodSummaryForCatalog),
    permissionSummary: permissionSummaryForCatalog(effective.connector),
  };
}

function connectorCatalogDetail(
  effective: EffectiveConnector,
): PublicConnectorCatalogDetail {
  return {
    ...connectorCatalogItem(effective),
    authMethods: effective.authMethods.map(authMethodDetailForCatalog),
  };
}

export function getAcceptedConnectorCatalogResolutionDetail(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectorSlug: string;
}): PublicConnectorCatalogDetail | null {
  const connector = args.snapshot.connectorBySlug.get(args.connectorSlug);
  return connector
    ? connectorCatalogDetail({
        connector,
        authMethods: connector.authMethods,
      })
    : null;
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

export function acceptedConnectorCatalogMethodIsCompatible(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectorSlug: string;
  readonly authMethodId: string;
}): boolean {
  return !args.snapshot.filteredMethodKeys.has(
    authMethodKey(args.connectorSlug, args.authMethodId),
  );
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
    authMethod: connector.authMethod,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    reconnectReason: connector.reconnectReason,
  };
}

function hasRequiredScopes(
  required: readonly string[],
  stored: readonly string[] | null,
): boolean {
  if (required.length === 0) {
    return true;
  }
  if (!stored) {
    return false;
  }
  const storedScopes = new Set(stored);
  return required.every((scope) => {
    return storedScopes.has(scope);
  });
}

function connectorCatalogStatusItem(args: {
  readonly catalog: AcceptedConnectorCatalogSnapshot;
  readonly effective: EffectiveConnector;
  readonly connector: ConnectorResponse | null;
}): PublicConnectorCatalogStatusItem {
  const detail = connectorCatalogDetail(args.effective);
  const effectiveMethod = args.connector
    ? args.effective.authMethods.find((method) => {
        return method.id === args.connector?.authMethod;
      })
    : undefined;
  const connector = effectiveMethod ? args.connector : null;
  const facts = effectiveMethod
    ? args.catalog.privateMethodFacts.get(
        authMethodKey(args.effective.connector.slug, effectiveMethod.id),
      )
    : undefined;
  if (effectiveMethod && !facts) {
    throw new Error("Connector catalog private method facts are missing");
  }
  const scopeMismatch =
    connector !== null &&
    facts !== undefined &&
    !hasRequiredScopes(facts.requiredScopes, connector.oauthScopes);
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
  args: ExternalCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const connectors = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  return {
    connectors: connectors.map(connectorCatalogItem),
    categoryMetadata: categoryMetadataForConnectors(catalog, connectors),
  };
}

export async function searchExternalConnectorCatalog(
  args: ExternalCatalogSearchArgs,
): Promise<ConnectorSearchItem[]> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const keyword = args.keyword?.toLowerCase();
  return effective.flatMap((entry) => {
    const connector = entry.connector;
    if (
      keyword &&
      !connector.label.toLowerCase().includes(keyword) &&
      !connector.description.toLowerCase().includes(keyword) &&
      !connector.tags.some((tag) => {
        return tag.toLowerCase().includes(keyword);
      })
    ) {
      return [];
    }
    return [
      {
        slug: connector.slug,
        label: connector.label,
        description: connector.description,
        authMethods: entry.authMethods.map((method) => {
          return method.id;
        }),
      },
    ];
  });
}

export async function getExternalPublicConnectorCatalogDetail(
  args: ExternalCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogDetail | null> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const connector = effective.find((entry) => {
    return entry.connector.slug === args.connectorSlug;
  });
  return connector ? connectorCatalogDetail(connector) : null;
}

export async function listExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogStatusArgs,
): Promise<ConnectorCatalogStatusRead> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const connectorsBySlug = new Map(
    args.connectors.map((connector) => {
      return [connector.slug, connector];
    }),
  );
  const connectors = effective.map((entry) => {
    return connectorCatalogStatusItem({
      catalog,
      effective: entry,
      connector: connectorsBySlug.get(entry.connector.slug) ?? null,
    });
  });
  return {
    status: {
      connectors,
      categoryMetadata: categoryMetadataForConnectors(catalog, effective),
    },
    referenceMetadata: referenceMetadataForCatalog(
      catalog,
      args.referenceConnectorSlugs,
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
    icon: iconForCatalog(entry.connector),
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
