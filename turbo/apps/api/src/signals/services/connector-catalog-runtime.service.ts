import type {
  ConnectorAuthMethodId,
  ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderRegistrationCapability,
} from "@vm0/connectors/auth-providers";
import {
  CONNECTOR_PLATFORM_SECRET_NAMES,
  type ConnectorAccessConfig,
  type ConnectorAuthClientConfig,
  type ConnectorAuthMethodRuntimeConfig,
  type ConnectorDeviceAuthStartOptionConfig,
  type ConnectorEnvBindingValue,
  type ConnectorGrantOutputBindings,
  type ConnectorPlatformSecretName,
  type PublicConnectorAuthClientConfig,
  type ConnectorRefreshTokenInputBindings,
  type ConnectorRefreshTokenOutputBindings,
  type ConnectorRevokeInputBindings,
  type ConnectorSecretValueRef,
  type ConnectorVariableValueRef,
} from "@vm0/connectors/connector-config";
import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRuntimeMetadata,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-auth-method";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { onRejection } from "../utils";
import type {
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
  ConnectorCatalogSkill,
} from "./connector-catalog-artifacts/artifacts";
import {
  getConnectorCatalogResolutionDetail,
  listAcceptedConnectorCatalogAvailableRefs,
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
import {
  readConnectorCatalogRuntimeProjectionIdentity,
  readConnectorCatalogRuntimeProjectionRows,
  type ConnectorCatalogRuntimeProjectionFallbackReason,
  type ConnectorCatalogRuntimeProjectionIdentity,
  type ConnectorCatalogRuntimeProjectionReadyIdentity,
} from "./connector-catalog-runtime-projection.service";
import {
  createAcceptedConnectorServerFirewallCatalog,
  type ConnectorServerFirewallCatalog,
} from "./connector-server-firewall-catalog.service";

export interface ConnectorRuntimeMethod {
  readonly connectorRef: ConnectorRef;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly executable: boolean;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}

export interface ConnectorRuntimeConnector {
  readonly connectorRef: ConnectorRef;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly methods: ReadonlyMap<ConnectorAuthMethodId, ConnectorRuntimeMethod>;
  readonly authoredVisibleMethodIds: ReadonlySet<ConnectorAuthMethodId>;
  readonly skill: ConnectorCatalogSkill;
}

export interface ConnectorRuntimeSelection {
  readonly connectors: ReadonlyMap<ConnectorRef, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
}

export interface ConnectorRuntimeSnapshot extends ConnectorRuntimeSelection {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
}

export type ConnectorRuntimeSelectionSource =
  | "projection"
  | "full_fallback"
  | "full_legacy"
  | "empty";

export type ConnectorRuntimeSelectionCacheStatus =
  | "hit"
  | "miss"
  | "not_applicable";

export interface ConnectorRuntimeSelectionLoad {
  readonly selection: ConnectorRuntimeSelection;
  readonly source: ConnectorRuntimeSelectionSource;
  readonly cacheStatus: ConnectorRuntimeSelectionCacheStatus;
  readonly fallbackReason?: ConnectorCatalogRuntimeProjectionFallbackReason;
}

function methodKey(connectorRef: string, authMethodId: string): string {
  return `${connectorRef}\0${authMethodId}`;
}

const providerRegistrations = singleton(() => {
  return new Map(
    getConnectorAuthProviderRegistrationCapabilities().map((registration) => {
      return [
        methodKey(registration.connectorRef, registration.authMethodId),
        registration,
      ];
    }),
  );
});

function providerRegistrationFor(
  connectorRef: string,
  authMethodId: string,
): ConnectorAuthProviderRegistrationCapability | null {
  return (
    providerRegistrations().get(methodKey(connectorRef, authMethodId)) ?? null
  );
}

function providerBackedGrant(
  kind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
): kind is "auth-code" | "device-auth" | "external-code" | "openid-auth" {
  return (
    kind === "auth-code" ||
    kind === "device-auth" ||
    kind === "external-code" ||
    kind === "openid-auth"
  );
}

function registrationSupportsMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}): boolean {
  if (
    providerBackedGrant(args.method.grant.kind) &&
    args.registration?.handlers.grant !== args.method.grant.kind
  ) {
    return false;
  }
  if (
    args.method.access.kind === "refresh-token" &&
    args.registration?.handlers.access !== "refresh-token"
  ) {
    return false;
  }
  if (
    args.method.revoke.kind === "token-revoke" &&
    args.registration?.handlers.revoke !== "token-revoke"
  ) {
    return false;
  }
  return true;
}

function isSecretValueRef(value: string): value is ConnectorSecretValueRef {
  return /^\$secrets\.[A-Z][A-Z0-9_]*$/u.test(value);
}

function isVariableValueRef(value: string): value is ConnectorVariableValueRef {
  return /^\$vars\.[A-Z][A-Z0-9_]*$/u.test(value);
}

function outputValueRef(
  value: string,
): ConnectorSecretValueRef | ConnectorVariableValueRef {
  if (isSecretValueRef(value) || isVariableValueRef(value)) {
    return value;
  }
  throw new Error("Invalid accepted connector value reference");
}

function secretValueRef(value: string): ConnectorSecretValueRef {
  if (isSecretValueRef(value)) {
    return value;
  }
  throw new Error("Invalid accepted connector secret reference");
}

function outputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorGrantOutputBindings {
  const result: ConnectorGrantOutputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function refreshInputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRefreshTokenInputBindings {
  const result: ConnectorRefreshTokenInputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function refreshOutputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRefreshTokenOutputBindings {
  const result: ConnectorRefreshTokenOutputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function revokeInputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRevokeInputBindings {
  const result: ConnectorRevokeInputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = secretValueRef(value);
  }
  return result;
}

function envBindingValue(
  binding: string | { readonly valueRef: string; readonly optional: true },
): ConnectorEnvBindingValue {
  return typeof binding === "string"
    ? outputValueRef(binding)
    : { valueRef: outputValueRef(binding.valueRef), optional: true };
}

function platformSecretName(value: string): ConnectorPlatformSecretName {
  const name = CONNECTOR_PLATFORM_SECRET_NAMES.find((candidate) => {
    return candidate === value;
  });
  if (name === undefined) {
    throw new Error("Unsupported accepted connector platform secret");
  }
  return name;
}

function runtimeAccess(
  access: ConnectorCatalogAuthMethod["access"],
): ConnectorAccessConfig {
  const envBindings: Record<string, ConnectorEnvBindingValue> = {};
  for (const [name, binding] of Object.entries(access.envBindings)) {
    envBindings[name] = envBindingValue(binding);
  }
  const platformSecrets = access.platformSecrets?.map(platformSecretName);
  if (access.kind === "static") {
    return {
      kind: "static",
      envBindings,
      ...(platformSecrets === undefined ? {} : { platformSecrets }),
    };
  }
  return {
    kind: "refresh-token",
    envBindings,
    ...(platformSecrets === undefined ? {} : { platformSecrets }),
    inputs: refreshInputBindings(access.inputs),
    outputs: refreshOutputBindings(access.outputs),
    refreshableSecrets: [...access.refreshableSecrets],
  };
}

function runtimeClient(
  client: ConnectorCatalogAuthMethod["client"],
): ConnectorAuthClientConfig | undefined {
  return client === undefined ? undefined : { ...client };
}

function requiredRuntimeClient(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthClientConfig {
  const client = runtimeClient(method.client);
  if (client === undefined) {
    throw new Error("Accepted connector auth method is missing its client");
  }
  return client;
}

function requiredPublicRuntimeClient(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorAuthClientConfig {
  const client = requiredRuntimeClient(method);
  if (client.clientType !== "public") {
    throw new Error("Accepted device auth method requires a public client");
  }
  return client;
}

function manualGrant(
  grant: Extract<ConnectorCatalogAuthMethod["grant"], { kind: "manual" }>,
): Extract<ConnectorAuthMethodRuntimeConfig["grant"], { kind: "manual" }> {
  const fields: Record<
    string,
    Extract<
      ConnectorAuthMethodRuntimeConfig["grant"],
      { kind: "manual" }
    >["fields"][string]
  > = {};
  for (const field of grant.fields) {
    fields[field.privateName] = {
      publicId: field.publicId,
      label: field.label,
      required: field.required,
      ...(field.placeholder === null ? {} : { placeholder: field.placeholder }),
      storage: field.storage,
      ...(field.normalize === undefined ? {} : { normalize: field.normalize }),
    };
  }
  return { kind: "manual", fields };
}

function deviceStartOption(
  option: Extract<
    ConnectorCatalogAuthMethod["grant"],
    { kind: "device-auth" }
  >["startOptions"][number],
): ConnectorDeviceAuthStartOptionConfig {
  const [first, ...rest] = option.options;
  if (first === undefined) {
    throw new Error("Accepted connector device option has no choices");
  }
  return {
    kind: "select",
    publicId: option.publicId,
    label: option.label,
    required: option.required,
    ...(option.defaultValue === null
      ? {}
      : { defaultValue: option.defaultValue }),
    options: [
      { ...first },
      ...rest.map((choice) => {
        return { ...choice };
      }),
    ],
  };
}

function deviceStartOptions(
  grant: Extract<ConnectorCatalogAuthMethod["grant"], { kind: "device-auth" }>,
): Readonly<Record<string, ConnectorDeviceAuthStartOptionConfig>> | undefined {
  const options: Record<string, ConnectorDeviceAuthStartOptionConfig> = {};
  for (const option of grant.startOptions) {
    options[option.privateName] = deviceStartOption(option);
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function runtimeMethod(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthMethodRuntimeConfig {
  const access = runtimeAccess(method.access);
  const revoke: ConnectorAuthMethodRuntimeConfig["revoke"] =
    method.revoke.kind === "none"
      ? { kind: "none" }
      : {
          kind: "token-revoke",
          inputs: revokeInputBindings(method.revoke.inputs),
          ...(method.revoke.revokePreviousOnReplace === undefined
            ? {}
            : {
                revokePreviousOnReplace: method.revoke.revokePreviousOnReplace,
              }),
        };
  const storage = {
    version: method.storage.version,
    secrets: [...method.storage.secrets],
    variables: [...method.storage.variables],
  };

  switch (method.grant.kind) {
    case "manual": {
      return {
        storage,
        grant: manualGrant(method.grant),
        access,
        revoke,
        ...(method.client === undefined
          ? {}
          : { client: runtimeClient(method.client) }),
      };
    }
    case "auth-code": {
      return {
        client: requiredRuntimeClient(method),
        storage,
        grant: {
          kind: "auth-code",
          scopes: [...method.grant.scopes],
          callbackOrigin: method.grant.callbackOrigin,
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "openid-auth": {
      return {
        ...(method.client === undefined
          ? {}
          : { client: runtimeClient(method.client) }),
        storage,
        grant: {
          kind: "openid-auth",
          callbackOrigin: method.grant.callbackOrigin,
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "external-code": {
      return {
        client: requiredRuntimeClient(method),
        storage,
        grant: {
          kind: "external-code",
          scopes: [...method.grant.scopes],
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "device-auth": {
      const startOptions = deviceStartOptions(method.grant);
      return {
        client: requiredPublicRuntimeClient(method),
        storage,
        grant: {
          kind: "device-auth",
          scopes: [...method.grant.scopes],
          outputs: outputBindings(method.grant.outputs),
          ...(startOptions === undefined ? {} : { startOptions }),
        },
        access,
        revoke,
      };
    }
  }
}

function runtimeMethodEntry(args: {
  readonly connectorRef: ConnectorRef;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): ConnectorRuntimeMethod {
  const registration = providerRegistrationFor(
    args.connectorRef,
    args.catalogMethod.id,
  );
  return {
    connectorRef: args.connectorRef,
    authMethodId: args.catalogMethod.id,
    catalogMethod: args.catalogMethod,
    method: args.method,
    registration,
    executable: registrationSupportsMethod({
      method: args.method,
      registration,
    }),
  };
}

function runtimeConnector(args: {
  readonly connector: ConnectorCatalogArtifactConnector;
  readonly filteredMethodKeys: ReadonlySet<string>;
}): ConnectorRuntimeConnector {
  const { connector } = args;
  const catalogConnector = getConnectorCatalogResolutionDetail(connector);
  const catalogMethods = new Map(
    catalogConnector.authMethods.map((method) => {
      return [method.id, method];
    }),
  );
  const methods = new Map<ConnectorAuthMethodId, ConnectorRuntimeMethod>();
  const authoredVisibleMethodIds = new Set<ConnectorAuthMethodId>();
  for (const method of connector.authMethods) {
    if (method.visible) {
      authoredVisibleMethodIds.add(method.id);
    }
    if (
      args.filteredMethodKeys.has(methodKey(connector.connectorRef, method.id))
    ) {
      continue;
    }
    const catalogMethod = catalogMethods.get(method.id);
    if (catalogMethod === undefined) {
      throw new Error("Accepted connector auth method alignment is incomplete");
    }
    methods.set(
      method.id,
      runtimeMethodEntry({
        connectorRef: connector.connectorRef,
        catalogMethod,
        method: runtimeMethod(method),
      }),
    );
  }
  return {
    connectorRef: connector.connectorRef,
    catalogConnector,
    methods,
    authoredVisibleMethodIds,
    skill: connector.skill,
  };
}

function runtimeSelection(args: {
  readonly acceptedConnectors: readonly ConnectorCatalogArtifactConnector[];
  readonly filteredMethodKeys: ReadonlySet<string>;
}): ConnectorRuntimeSelection {
  const connectors = new Map<ConnectorRef, ConnectorRuntimeConnector>();

  for (const connector of args.acceptedConnectors) {
    connectors.set(connector.connectorRef, {
      ...runtimeConnector({
        connector,
        filteredMethodKeys: args.filteredMethodKeys,
      }),
    });
  }
  const runtimeMethodsByRef = new Map(
    [...connectors.entries()].map(([connectorRef, connector]) => {
      return [
        connectorRef,
        [...connector.methods.values()].map((method) => {
          return method.method;
        }),
      ];
    }),
  );
  const serverFirewalls = createAcceptedConnectorServerFirewallCatalog({
    connectors: args.acceptedConnectors,
    runtimeMethodsByRef,
  });
  return {
    connectors,
    serverFirewalls,
  };
}

function runtimeSnapshot(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
): ConnectorRuntimeSnapshot {
  return {
    acceptedSnapshot,
    ...runtimeSelection({
      acceptedConnectors: acceptedSnapshot.artifact.connectors,
      filteredMethodKeys: acceptedSnapshot.filteredMethodKeys,
    }),
  };
}

function runtimeSnapshotKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

interface RuntimeSnapshotCache {
  key: string | undefined;
  snapshot: ConnectorRuntimeSnapshot | undefined;
}

const runtimeSnapshotCache = singleton((): RuntimeSnapshotCache => {
  return { key: undefined, snapshot: undefined };
});

export async function loadConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot> {
  const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const key = runtimeSnapshotKey(acceptedSnapshot.identity);
  const cache = runtimeSnapshotCache();
  if (cache.key === key && cache.snapshot !== undefined) {
    return cache.snapshot;
  }
  const snapshot = runtimeSnapshot(acceptedSnapshot);
  cache.key = key;
  cache.snapshot = snapshot;
  return snapshot;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeSelectionProjectionKey(args: {
  readonly identity: ConnectorCatalogRuntimeProjectionIdentity;
  readonly connectorRefs: readonly ConnectorRef[];
}): string {
  return [
    args.identity.sourceId,
    args.identity.schemaVersion,
    args.identity.catalogVersion,
    args.identity.catalogDigest,
    args.identity.capabilityDigest,
    args.identity.projectionVersion,
    ...args.connectorRefs,
  ].join("\0");
}

interface RuntimeSelectionCache {
  completed:
    | {
        readonly key: string;
        readonly selection: ConnectorRuntimeSelection;
      }
    | undefined;
  inFlight:
    | {
        readonly key: string;
        readonly promise: Promise<ConnectorRuntimeSelectionLoad>;
      }
    | undefined;
}

const runtimeSelectionCache = singleton((): RuntimeSelectionCache => {
  return { completed: undefined, inFlight: undefined };
});

async function buildProjectedRuntimeSelection(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorRefs: readonly ConnectorRef[];
}): Promise<ConnectorRuntimeSelectionLoad> {
  const rows = await readConnectorCatalogRuntimeProjectionRows(args);
  if (rows.kind === "fallback") {
    return {
      selection: await loadConnectorRuntimeSnapshot(args.db),
      source: "full_fallback",
      cacheStatus: "not_applicable",
      fallbackReason: rows.reason,
    };
  }
  return {
    selection: runtimeSelection({
      acceptedConnectors: rows.connectors,
      filteredMethodKeys: new Set(
        args.projection.filteredAuthMethods.map((method) => {
          return methodKey(method.connectorRef, method.authMethodId);
        }),
      ),
    }),
    source: "projection",
    cacheStatus: "miss",
  };
}

function clearRuntimeSelectionInFlight(
  cache: RuntimeSelectionCache,
  key: string,
  promise: Promise<ConnectorRuntimeSelectionLoad>,
): void {
  if (cache.inFlight?.key === key && cache.inFlight.promise === promise) {
    cache.inFlight = undefined;
  }
}

export async function loadConnectorRuntimeSelection(
  db: ReadonlyDb,
  connectorRefs: readonly ConnectorRef[],
): Promise<ConnectorRuntimeSelectionLoad> {
  const selectedRefs = [...new Set(connectorRefs)].sort(compareStrings);
  if (selectedRefs.length === 0) {
    return {
      selection: runtimeSelection({
        acceptedConnectors: [],
        filteredMethodKeys: new Set(),
      }),
      source: "empty",
      cacheStatus: "not_applicable",
    };
  }

  const identity = await readConnectorCatalogRuntimeProjectionIdentity(db);
  if (identity.kind === "fallback") {
    return {
      selection: await loadConnectorRuntimeSnapshot(db),
      source: "full_fallback",
      cacheStatus: "not_applicable",
      fallbackReason: identity.reason,
    };
  }
  const key = runtimeSelectionProjectionKey({
    identity: identity.projection.identity,
    connectorRefs: selectedRefs,
  });
  const cache = runtimeSelectionCache();
  if (cache.completed?.key === key) {
    return {
      selection: cache.completed.selection,
      source: "projection",
      cacheStatus: "hit",
    };
  }
  if (cache.inFlight?.key === key) {
    const result = await cache.inFlight.promise;
    return result.source === "projection"
      ? { ...result, cacheStatus: "hit" }
      : result;
  }

  const promise = buildProjectedRuntimeSelection({
    db,
    projection: identity.projection,
    connectorRefs: selectedRefs,
  });
  cache.inFlight = { key, promise };
  const result = await onRejection(promise, () => {
    clearRuntimeSelectionInFlight(cache, key, promise);
  });
  clearRuntimeSelectionInFlight(cache, key, promise);
  if (result.source === "projection") {
    cache.completed = { key, selection: result.selection };
  }
  return result;
}

export function getConnectorRuntimeConnector(
  snapshot: ConnectorRuntimeSelection,
  connectorRef: string,
): ConnectorRuntimeConnector | undefined {
  return snapshot.connectors.get(connectorRef);
}

export function getConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly requireExecutable?: boolean;
}): ConnectorRuntimeMethod | undefined {
  const method = args.snapshot.connectors
    .get(args.connectorRef)
    ?.methods.get(args.authMethodId);
  if (args.requireExecutable === true && method?.executable !== true) {
    return undefined;
  }
  return method;
}

export function getConnectorRuntimeStoredSecretDisplayInfo(
  snapshot: ConnectorRuntimeSnapshot,
  secretName: string,
): {
  readonly label: string;
  readonly environmentNames: readonly string[];
} | null {
  for (const connector of snapshot.connectors.values()) {
    const methods = [...connector.methods.values()];
    if (
      !methods.some((runtimeMethod) => {
        return connectorAuthMethodOwnedSecretNames(
          runtimeMethod.method,
        ).includes(secretName);
      })
    ) {
      continue;
    }
    const environmentNames = [
      ...new Set(
        methods.flatMap((runtimeMethod) => {
          return connectorAuthMethodRuntimeMetadata(runtimeMethod.method)
            .runtimeBindings.filter((binding) => {
              return (
                binding.source.kind === "connector-secret" &&
                binding.source.name === secretName
              );
            })
            .map((binding) => {
              return binding.envName;
            });
        }),
      ),
    ];
    if (environmentNames.length > 0) {
      return {
        label: connector.catalogConnector.label,
        environmentNames,
      };
    }
  }
  return null;
}

export function listConnectorRuntimeVisibleRefs(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorRef[] {
  return listAcceptedConnectorCatalogAvailableRefs({
    snapshot: args.snapshot.acceptedSnapshot,
    featureStates: args.featureStates,
  });
}
