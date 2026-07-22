import {
  connectorCatalogFilteredAuthMethodsSchema,
  type ConnectorCatalogCompatibilityReason,
  type ConnectorCatalogFilteredAuthMethod,
} from "@vm0/api-contracts/contracts/cron";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
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
import type { ConnectorFeatureStates } from "@vm0/connectors/connector-utils";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { staticConnectorIconPublicPathUrl } from "@vm0/connectors/static-connector-icons";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
} from "@vm0/db/schema/connector-catalog";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { safeJsonParse } from "../utils";
import { singleton } from "../../lib/singleton";
import {
  connectorCatalogIntegrityArtifactSchema,
  connectorCatalogPrivateArtifactSchema,
  connectorCatalogPrivateFirewallsArtifactSchema,
  connectorCatalogPublicArtifactSchema,
  connectorCatalogRunnerFirewallsArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPrivateFirewallsArtifact,
  type ConnectorCatalogPublicArtifact,
  type ConnectorCatalogRunnerFirewallsArtifact,
  validateConnectorCatalogArtifacts,
} from "./connector-catalog-artifacts/artifacts";
import { connectorCatalogExecutableCapabilityDigest } from "./connector-catalog-compatibility.service";
import { connectorCatalogSource } from "./connector-catalog-sync.service";

type PublicArtifactConnector =
  ConnectorCatalogPublicArtifact["connectors"][number];
type PublicArtifactAuthMethod = PublicArtifactConnector["authMethods"][number];
type PrivateArtifactAuthMethod =
  ConnectorCatalogPrivateArtifact["connectors"][number]["authMethods"][number];

export interface ExternalCatalogIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly integrityDigest: string;
  readonly capabilityDigest: string;
}

interface PrivateAuthMethodFacts {
  readonly requiredScopes: readonly string[];
  readonly supportsRefresh: boolean;
}

export interface AcceptedConnectorCatalogSnapshot {
  readonly identity: ExternalCatalogIdentity;
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
  readonly runnerFirewallsArtifact: ConnectorCatalogRunnerFirewallsArtifact;
  readonly privateMethodFacts: ReadonlyMap<string, PrivateAuthMethodFacts>;
  readonly filteredMethodKeys: ReadonlySet<string>;
  readonly compatibilityReasonCounts: Readonly<
    Partial<Record<ConnectorCatalogCompatibilityReason, number>>
  >;
  readonly rawConnectorCount: number;
  readonly rawAuthMethodCount: number;
  readonly compatibilityFilteredMethodCount: number;
}

interface PreparedExternalCatalogCache {
  key: string | undefined;
  catalog: AcceptedConnectorCatalogSnapshot | undefined;
}

interface RequestFilteringCounts {
  readonly visibilityFilteredMethodCount: number;
  readonly rolloutFilteredMethodCount: number;
  readonly surfacePolicyFilteredMethodCount: number;
  readonly removedConnectorCount: number;
}

interface EffectiveConnector {
  readonly connector: PublicArtifactConnector;
  readonly authMethods: readonly PublicArtifactAuthMethod[];
}

export interface ExternalConnectorCatalogDiagnostics
  extends ExternalCatalogIdentity, RequestFilteringCounts {
  readonly rawConnectorCount: number;
  readonly rawAuthMethodCount: number;
  readonly compatibilityFilteredMethodCount: number;
  readonly compatibilityReasonCounts: Readonly<
    Partial<Record<ConnectorCatalogCompatibilityReason, number>>
  >;
}

export interface ExternalConnectorCatalogRead<T> {
  readonly value: T;
  readonly diagnostics: ExternalConnectorCatalogDiagnostics;
}

interface ExternalCatalogReadArgs {
  readonly db: ReadonlyDb;
  readonly featureStates: ConnectorFeatureStates;
}

interface ExternalCatalogConnectorReadArgs extends ExternalCatalogReadArgs {
  readonly connectorRef: string;
}

interface ExternalCatalogSearchArgs extends ExternalCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ExternalCatalogStatusArgs extends ExternalCatalogReadArgs {
  readonly connectors: readonly ConnectorResponse[];
  readonly referenceConnectorRefs: readonly string[];
}

export interface ConnectorCatalogReferenceMetadata {
  readonly connectorRef: string;
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
  return { key: undefined, catalog: undefined };
});

function authMethodKey(connectorRef: string, authMethodId: string): string {
  return `${connectorRef}\0${authMethodId}`;
}

function identityKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.integrityDigest,
    identity.capabilityDigest,
  ].join("\0");
}

function isRecognizedFeatureSwitchKey(
  value: string,
): value is FeatureSwitchKey {
  return Object.values(FeatureSwitchKey).some((key) => {
    return key === value;
  });
}

function requiredScopes(method: PrivateArtifactAuthMethod): readonly string[] {
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
  privateArtifact: ConnectorCatalogPrivateArtifact,
): ReadonlyMap<string, PrivateAuthMethodFacts> {
  const facts = new Map<string, PrivateAuthMethodFacts>();
  for (const connector of privateArtifact.connectors) {
    for (const method of connector.authMethods) {
      facts.set(authMethodKey(connector.connectorRef, method.id), {
        requiredScopes: [...requiredScopes(method)],
        supportsRefresh: method.access.kind === "refresh-token",
      });
    }
  }
  return facts;
}

function compatibilityReasonCounts(
  filteredAuthMethods: readonly ConnectorCatalogFilteredAuthMethod[],
): Readonly<Partial<Record<ConnectorCatalogCompatibilityReason, number>>> {
  const counts: Partial<Record<ConnectorCatalogCompatibilityReason, number>> =
    {};
  for (const filtered of filteredAuthMethods) {
    for (const reason of filtered.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
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
      connectorCatalogCompatibilityEvaluation.integrityDigest,
      connectorCatalogActiveSnapshot.integrityDigest,
    ),
  );
}

async function readCurrentIdentity(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
}): Promise<ExternalCatalogIdentity | undefined> {
  const [row] = await args.db
    .select({
      schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      integrityDigest: connectorCatalogActiveSnapshot.integrityDigest,
    })
    .from(connectorCatalogActiveSnapshot)
    .innerJoin(connectorCatalogCompatibilityEvaluation, externalCatalogJoin())
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
  return row
    ? {
        sourceId: args.sourceId,
        schemaVersion: row.schemaVersion,
        catalogVersion: row.catalogVersion,
        integrityDigest: row.integrityDigest,
        capabilityDigest: args.capabilityDigest,
      }
    : undefined;
}

async function readCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
}): Promise<AcceptedConnectorCatalogSnapshot | undefined> {
  const [row] = await args.db
    .select({
      schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      integrityDigest: connectorCatalogActiveSnapshot.integrityDigest,
      publicCatalogDigest: connectorCatalogActiveSnapshot.publicCatalogDigest,
      privateCatalogDigest: connectorCatalogActiveSnapshot.privateCatalogDigest,
      privateFirewallsDigest:
        connectorCatalogActiveSnapshot.privateFirewallsDigest,
      runnerFirewallsDigest:
        connectorCatalogActiveSnapshot.runnerFirewallsDigest,
      publicCatalog: connectorCatalogActiveSnapshot.publicCatalog,
      privateCatalog: connectorCatalogActiveSnapshot.privateCatalog,
      privateFirewalls: connectorCatalogActiveSnapshot.privateFirewalls,
      runnerFirewalls: connectorCatalogActiveSnapshot.runnerFirewalls,
      filteredAuthMethods:
        connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogActiveSnapshot)
    .innerJoin(connectorCatalogCompatibilityEvaluation, externalCatalogJoin())
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
  if (!row) {
    return undefined;
  }

  const publicArtifact = connectorCatalogPublicArtifactSchema.parse(
    safeJsonParse(row.publicCatalog),
  );
  const privateArtifact = connectorCatalogPrivateArtifactSchema.parse(
    safeJsonParse(row.privateCatalog),
  );
  const privateFirewallsArtifact =
    connectorCatalogPrivateFirewallsArtifactSchema.parse(
      safeJsonParse(row.privateFirewalls),
    );
  const runnerFirewallsArtifact =
    connectorCatalogRunnerFirewallsArtifactSchema.parse(
      safeJsonParse(row.runnerFirewalls),
    );
  const integrity = connectorCatalogIntegrityArtifactSchema.parse({
    artifactSchemaVersion: row.schemaVersion,
    catalogVersion: row.catalogVersion,
    artifacts: {
      publicCatalog: row.publicCatalogDigest,
      privateCatalog: row.privateCatalogDigest,
      privateFirewalls: row.privateFirewallsDigest,
      runnerFirewalls: row.runnerFirewallsDigest,
    },
  });
  validateConnectorCatalogArtifacts({
    publicArtifact,
    privateArtifact,
    privateFirewallsArtifact,
    runnerFirewallsArtifact,
    integrity,
  });
  const filteredAuthMethods = connectorCatalogFilteredAuthMethodsSchema.parse(
    row.filteredAuthMethods,
  );
  const identity: ExternalCatalogIdentity = {
    sourceId: args.sourceId,
    schemaVersion: row.schemaVersion,
    catalogVersion: row.catalogVersion,
    integrityDigest: row.integrityDigest,
    capabilityDigest: args.capabilityDigest,
  };

  return {
    identity,
    publicArtifact,
    privateArtifact,
    privateFirewallsArtifact,
    runnerFirewallsArtifact,
    privateMethodFacts: privateMethodFacts(privateArtifact),
    filteredMethodKeys: new Set(
      filteredAuthMethods.map((filtered) => {
        return authMethodKey(filtered.connectorRef, filtered.authMethodId);
      }),
    ),
    compatibilityReasonCounts: compatibilityReasonCounts(filteredAuthMethods),
    rawConnectorCount: publicArtifact.connectors.length,
    rawAuthMethodCount: publicArtifact.connectors.reduce((count, connector) => {
      return count + connector.authMethods.length;
    }, 0),
    compatibilityFilteredMethodCount: filteredAuthMethods.length,
  };
}

export async function loadAcceptedConnectorCatalogSnapshot(
  db: ReadonlyDb,
): Promise<AcceptedConnectorCatalogSnapshot> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityDigest();
  const currentIdentity = await readCurrentIdentity({
    db,
    sourceId,
    capabilityDigest,
  });
  if (!currentIdentity) {
    throw new ExternalConnectorCatalogUnavailableError();
  }
  const currentKey = identityKey(currentIdentity);
  const cache = preparedCatalogCache();
  if (cache.key === currentKey && cache.catalog) {
    return cache.catalog;
  }

  const catalog = await readCurrentCatalog({ db, sourceId, capabilityDigest });
  if (!catalog) {
    throw new ExternalConnectorCatalogUnavailableError();
  }
  cache.key = identityKey(catalog.identity);
  cache.catalog = catalog;
  return catalog;
}

/**
 * Applies rollout policy to discovery projections only. Feature switches must
 * never be reused as connector authorization or execution checks;
 * ConnectorActionResolver intentionally does not read them.
 */
function featureSwitchEnabled(
  method: PublicArtifactAuthMethod,
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
}): {
  readonly connectors: readonly EffectiveConnector[];
  readonly counts: RequestFilteringCounts;
} {
  let visibilityFilteredMethodCount = 0;
  let rolloutFilteredMethodCount = 0;
  let removedConnectorCount = 0;
  const connectors = args.catalog.publicArtifact.connectors.flatMap(
    (connector) => {
      const authMethods = connector.authMethods.filter((method) => {
        if (
          args.catalog.filteredMethodKeys.has(
            authMethodKey(connector.connectorRef, method.id),
          )
        ) {
          return false;
        }
        if (!method.visible) {
          visibilityFilteredMethodCount += 1;
          return false;
        }
        if (!featureSwitchEnabled(method, args.featureStates)) {
          rolloutFilteredMethodCount += 1;
          return false;
        }
        return true;
      });
      if (authMethods.length === 0) {
        removedConnectorCount += 1;
        return [];
      }
      return [{ connector, authMethods }];
    },
  );
  return {
    connectors,
    counts: {
      visibilityFilteredMethodCount,
      rolloutFilteredMethodCount,
      // Artifact schema v1 contains no managed grant, so current public
      // surfaces have no additional method policy to apply here.
      surfacePolicyFilteredMethodCount: 0,
      removedConnectorCount,
    },
  };
}

function diagnostics(
  catalog: AcceptedConnectorCatalogSnapshot,
  counts: RequestFilteringCounts,
): ExternalConnectorCatalogDiagnostics {
  return {
    ...catalog.identity,
    ...counts,
    rawConnectorCount: catalog.rawConnectorCount,
    rawAuthMethodCount: catalog.rawAuthMethodCount,
    compatibilityFilteredMethodCount: catalog.compatibilityFilteredMethodCount,
    compatibilityReasonCounts: catalog.compatibilityReasonCounts,
  };
}

function iconForCatalog(
  connector: PublicArtifactConnector,
): PublicConnectorCatalogIcon {
  return {
    url: staticConnectorIconPublicPathUrl(connector.icon.asset.key),
    invertInDarkMode: connector.icon.invertInDarkMode,
    ...(connector.icon.scale === undefined
      ? {}
      : { scale: connector.icon.scale }),
  };
}

function referenceMetadataForCatalog(
  catalog: AcceptedConnectorCatalogSnapshot,
  connectorRefs: readonly string[],
): readonly ConnectorCatalogReferenceMetadata[] {
  const requestedRefs = new Set(connectorRefs);
  return catalog.publicArtifact.connectors.flatMap((connector) => {
    return requestedRefs.has(connector.connectorRef)
      ? [
          {
            connectorRef: connector.connectorRef,
            label: connector.label,
            icon: iconForCatalog(connector),
          },
        ]
      : [];
  });
}

function permissionSummaryForCatalog(
  connector: PublicArtifactConnector,
): PublicConnectorCatalogPermissionSummary {
  if (connector.firewall.kind === "none") {
    return {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    };
  }
  const permissionCount = connector.firewall.permissions.length;
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
  method: PublicArtifactAuthMethod,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: method.id,
    label: method.label,
    description: method.description,
    grantKind: method.grantKind,
  };
}

function authMethodDetailForCatalog(
  method: PublicArtifactAuthMethod,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(method),
    manualFields: method.manualFields.map((field) => {
      return { ...field };
    }),
    startOptions: method.startOptions.map((option) => {
      return {
        ...option,
        options: option.options.map((choice) => {
          return { ...choice };
        }),
      };
    }),
  };
}

function connectorCatalogItem(
  effective: EffectiveConnector,
): PublicConnectorCatalogItem {
  return {
    connectorRef: effective.connector.connectorRef,
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
  readonly connectorRef: string;
}): PublicConnectorCatalogDetail | null {
  const connector = args.snapshot.publicArtifact.connectors.find((entry) => {
    return entry.connectorRef === args.connectorRef;
  });
  return connector
    ? connectorCatalogDetail({
        connector,
        authMethods: connector.authMethods,
      })
    : null;
}

export function getAcceptedConnectorCatalogAvailableDetail(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectorRef: string;
  readonly featureStates: ConnectorFeatureStates;
}): PublicConnectorCatalogDetail | null {
  const effective = effectiveConnectors({
    catalog: args.snapshot,
    featureStates: args.featureStates,
  });
  const connector = effective.connectors.find((entry) => {
    return entry.connector.connectorRef === args.connectorRef;
  });
  return connector ? connectorCatalogDetail(connector) : null;
}

export function listAcceptedConnectorCatalogAvailableRefs(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorRef[] {
  return effectiveConnectors({
    catalog: args.snapshot,
    featureStates: args.featureStates,
  })
    .connectors.map((entry) => {
      return entry.connector.connectorRef;
    })
    .sort();
}

export function acceptedConnectorCatalogMethodIsCompatible(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectorRef: string;
  readonly authMethodId: string;
}): boolean {
  return !args.snapshot.filteredMethodKeys.has(
    authMethodKey(args.connectorRef, args.authMethodId),
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
  const categories = catalog.publicArtifact.categoryMetadata.categories.filter(
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
    groups: catalog.publicArtifact.categoryMetadata.groups
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
        authMethodKey(
          args.effective.connector.connectorRef,
          effectiveMethod.id,
        ),
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
      singleMethod?.grantKind === "auth-code"
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
  connector: PublicArtifactConnector,
): PublicConnectorCatalogPermissionDetail["defaultPolicy"] {
  if (connector.firewall.kind === "none") {
    throw new Error("Connector catalog firewall metadata is unavailable");
  }
  const permissionNames = connector.firewall.permissions.map((permission) => {
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
): Promise<ExternalConnectorCatalogRead<PublicConnectorCatalogListResponse>> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  return {
    value: {
      connectors: effective.connectors.map(connectorCatalogItem),
      categoryMetadata: categoryMetadataForConnectors(
        catalog,
        effective.connectors,
      ),
    },
    diagnostics: diagnostics(catalog, effective.counts),
  };
}

export async function searchExternalConnectorCatalog(
  args: ExternalCatalogSearchArgs,
): Promise<ExternalConnectorCatalogRead<ConnectorSearchItem[]>> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const keyword = args.keyword?.toLowerCase();
  const connectors = effective.connectors.flatMap((entry) => {
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
        id: connector.connectorRef,
        label: connector.label,
        description: connector.description,
        authMethods: entry.authMethods.map((method) => {
          return method.id;
        }),
      },
    ];
  });
  return {
    value: connectors,
    diagnostics: diagnostics(catalog, effective.counts),
  };
}

export async function getExternalPublicConnectorCatalogDetail(
  args: ExternalCatalogConnectorReadArgs,
): Promise<ExternalConnectorCatalogRead<PublicConnectorCatalogDetail | null>> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const connector = effective.connectors.find((entry) => {
    return entry.connector.connectorRef === args.connectorRef;
  });
  return {
    value: connector ? connectorCatalogDetail(connector) : null,
    diagnostics: diagnostics(catalog, effective.counts),
  };
}

export async function listExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogStatusArgs,
): Promise<ExternalConnectorCatalogRead<ConnectorCatalogStatusRead>> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const connectorsByType = new Map(
    args.connectors.map((connector) => {
      return [connector.type, connector];
    }),
  );
  const connectors = effective.connectors.map((entry) => {
    return connectorCatalogStatusItem({
      catalog,
      effective: entry,
      connector: connectorsByType.get(entry.connector.connectorRef) ?? null,
    });
  });
  return {
    value: {
      status: {
        connectors,
        categoryMetadata: categoryMetadataForConnectors(
          catalog,
          effective.connectors,
        ),
      },
      referenceMetadata: referenceMetadataForCatalog(
        catalog,
        args.referenceConnectorRefs,
      ),
    },
    diagnostics: diagnostics(catalog, effective.counts),
  };
}

export async function getExternalPublicConnectorCatalogPermissionDetail(
  args: ExternalCatalogConnectorReadArgs,
): Promise<
  ExternalConnectorCatalogRead<PublicConnectorCatalogPermissionDetail | null>
> {
  const catalog = await loadAcceptedConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog,
    featureStates: args.featureStates,
  });
  const entry = effective.connectors.find((connector) => {
    return connector.connector.connectorRef === args.connectorRef;
  });
  if (!entry || entry.connector.firewall.kind === "none") {
    return {
      value: null,
      diagnostics: diagnostics(catalog, effective.counts),
    };
  }
  const firewall = entry.connector.firewall;
  return {
    value: {
      connectorRef: entry.connector.connectorRef,
      label: entry.connector.label,
      icon: iconForCatalog(entry.connector),
      permissionCount: firewall.permissions.length,
      permissions: firewall.permissions.map((permission) => {
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
    },
    diagnostics: diagnostics(catalog, effective.counts),
  };
}
