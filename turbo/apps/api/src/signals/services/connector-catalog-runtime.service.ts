import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@okouai/api-contracts/contracts/zero-connector-catalog";
import {
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderRegistrationCapability,
} from "@okouai/connectors/auth-providers";
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
} from "@okouai/connectors/connector-config";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type {
  ConnectorCatalogAuthMethod,
  ConnectorCatalogSkill,
} from "./connector-catalog-artifacts/artifacts";
import {
  acceptedConnectorCatalogMethodIsCompatible,
  getAcceptedConnectorCatalogResolutionDetail,
  listAcceptedConnectorCatalogAvailableSlugs,
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import { ConnectorCatalogLoadTiming } from "./connector-catalog-load-timing.service";
import {
  createAcceptedConnectorServerFirewallCatalog,
  selectConnectorServerFirewalls,
  type ConnectorServerFirewallCatalog,
  type ConnectorServerFirewallMetadataCatalog,
  type ConnectorServerFirewallSelection,
} from "./connector-server-firewall-catalog.service";

export interface ConnectorRuntimeMethod {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly executable: boolean;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}

export interface ConnectorRuntimeConnector {
  readonly connectorSlug: ConnectorSlug;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly methods: ReadonlyMap<ConnectorAuthMethodId, ConnectorRuntimeMethod>;
  readonly authoredVisibleMethodIds: ReadonlySet<ConnectorAuthMethodId>;
  readonly skill: ConnectorCatalogSkill;
}

export interface ConnectorRuntimeSelection {
  readonly catalogIdentity: ExternalCatalogIdentity;
  readonly connectors: ReadonlyMap<ConnectorSlug, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallSelection;
  readonly serverFirewallMetadata: ConnectorServerFirewallMetadataCatalog;
}

export interface ConnectorRuntimeSnapshot extends ConnectorRuntimeSelection {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
  readonly serverFirewallMetadata: ConnectorServerFirewallCatalog;
}

function methodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

const providerRegistrations = singleton(() => {
  return new Map(
    getConnectorAuthProviderRegistrationCapabilities().map((registration) => {
      return [
        methodKey(registration.connectorSlug, registration.authMethodId),
        registration,
      ];
    }),
  );
});

function providerRegistrationFor(
  connectorSlug: string,
  authMethodId: string,
): ConnectorAuthProviderRegistrationCapability | null {
  return (
    providerRegistrations().get(methodKey(connectorSlug, authMethodId)) ?? null
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
  readonly connectorSlug: ConnectorSlug;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): ConnectorRuntimeMethod {
  const registration = providerRegistrationFor(
    args.connectorSlug,
    args.catalogMethod.id,
  );
  return {
    connectorSlug: args.connectorSlug,
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

function runtimeConnector(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  connectorSlug: ConnectorSlug,
): ConnectorRuntimeConnector {
  const connector = acceptedSnapshot.connectorBySlug.get(connectorSlug);
  if (connector === undefined) {
    throw new Error("Accepted connector runtime source is unavailable");
  }
  const catalogConnector = getAcceptedConnectorCatalogResolutionDetail({
    snapshot: acceptedSnapshot,
    connectorSlug,
  });
  if (catalogConnector === null) {
    throw new Error("Accepted connector runtime relationship is incomplete");
  }
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
      !acceptedConnectorCatalogMethodIsCompatible({
        snapshot: acceptedSnapshot,
        connectorSlug,
        authMethodId: method.id,
      })
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
        connectorSlug,
        catalogMethod,
        method: runtimeMethod(method),
      }),
    );
  }
  return {
    connectorSlug,
    catalogConnector,
    methods,
    authoredVisibleMethodIds,
    skill: connector.skill,
  };
}

function runtimeCatalogKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

interface ConnectorRuntimeState {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectors: Map<ConnectorSlug, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
  snapshot: ConnectorRuntimeSnapshot | undefined;
}

interface RuntimeCatalogCache {
  key: string | undefined;
  state: ConnectorRuntimeState | undefined;
}

const runtimeCatalogCache = singleton((): RuntimeCatalogCache => {
  return { key: undefined, state: undefined };
});

function materializeConnectorRuntimeEntry(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  connectors: Map<ConnectorSlug, ConnectorRuntimeConnector>,
  connectorSlug: ConnectorSlug,
): ConnectorRuntimeConnector {
  const cached = connectors.get(connectorSlug);
  if (cached !== undefined) {
    return cached;
  }
  const connector = runtimeConnector(acceptedSnapshot, connectorSlug);
  connectors.set(connectorSlug, connector);
  return connector;
}

function connectorRuntimeState(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  timing: ConnectorCatalogLoadTiming | undefined,
): { readonly state: ConnectorRuntimeState; readonly created: boolean } {
  const key = runtimeCatalogKey(acceptedSnapshot.identity);
  const cache = runtimeCatalogCache();
  if (cache.key === key && cache.state !== undefined) {
    return { state: cache.state, created: false };
  }
  const connectors = new Map<ConnectorSlug, ConnectorRuntimeConnector>();
  const createServerFirewalls = (): ConnectorServerFirewallCatalog => {
    return createAcceptedConnectorServerFirewallCatalog({
      artifact: acceptedSnapshot.artifact,
      runtimeMethodsForSlug: (connectorSlug) => {
        return [
          ...materializeConnectorRuntimeEntry(
            acceptedSnapshot,
            connectors,
            connectorSlug,
          ).methods.values(),
        ].map((method) => {
          return method.method;
        });
      },
    });
  };
  const state: ConnectorRuntimeState = {
    acceptedSnapshot,
    connectors,
    serverFirewalls: timing
      ? timing.measureSync(
          "api_dispatch_connector_catalog_materialize_server_firewalls",
          () => {
            return createServerFirewalls();
          },
        )
      : createServerFirewalls(),
    snapshot: undefined,
  };
  cache.key = key;
  cache.state = state;
  return { state, created: true };
}

function acceptedRequestedConnectorSlugs(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  requestedConnectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  return [...new Set(requestedConnectorSlugs)].filter((connectorSlug) => {
    return acceptedSnapshot.connectorBySlug.has(connectorSlug);
  });
}

function selectedRuntimeConnectors(
  state: ConnectorRuntimeState,
  connectorSlugs: readonly ConnectorSlug[],
): ReadonlyMap<ConnectorSlug, ConnectorRuntimeConnector> {
  return new Map(
    connectorSlugs.map(
      (connectorSlug): [ConnectorSlug, ConnectorRuntimeConnector] => {
        return [
          connectorSlug,
          materializeConnectorRuntimeEntry(
            state.acceptedSnapshot,
            state.connectors,
            connectorSlug,
          ),
        ];
      },
    ),
  );
}

export async function loadConnectorRuntimeSelection(
  db: ReadonlyDb,
  options: {
    readonly timing: ApiDispatchTimingCollector;
    readonly requestedConnectorSlugs: readonly ConnectorSlug[];
  },
): Promise<ConnectorRuntimeSelection> {
  const timing = new ConnectorCatalogLoadTiming(
    options.timing,
    options.requestedConnectorSlugs.length,
  );
  return await timing.measureComplete(async () => {
    const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(
      db,
      timing,
    );
    const connectorSlugs = acceptedRequestedConnectorSlugs(
      acceptedSnapshot,
      options.requestedConnectorSlugs,
    );
    timing.recordCatalogFacts({
      rawSize: acceptedSnapshot.catalogRawSize,
      compressedSize: acceptedSnapshot.catalogCompressedSize,
      connectorCount: acceptedSnapshot.artifact.connectors.length,
      resolvedConnectorCount: connectorSlugs.length,
    });
    const { state, created } = connectorRuntimeState(acceptedSnapshot, timing);
    const missingConnectorSlugs = connectorSlugs.filter((connectorSlug) => {
      return !state.connectors.has(connectorSlug);
    });
    const cacheMiss = created || missingConnectorSlugs.length > 0;
    timing.recordRuntimeCacheOutcome(cacheMiss ? "miss" : "hit");
    timing.recordMaterializedConnectorCount(missingConnectorSlugs.length);
    if (cacheMiss) {
      timing.measureSync(
        "api_dispatch_connector_catalog_materialize_runtime_snapshot",
        () => {
          for (const connectorSlug of missingConnectorSlugs) {
            materializeConnectorRuntimeEntry(
              state.acceptedSnapshot,
              state.connectors,
              connectorSlug,
            );
          }
        },
      );
    }
    const connectors = selectedRuntimeConnectors(state, connectorSlugs);
    return {
      catalogIdentity: acceptedSnapshot.identity,
      connectors,
      serverFirewalls: selectConnectorServerFirewalls({
        catalog: state.serverFirewalls,
        connectorSlugs,
      }),
      serverFirewallMetadata: state.serverFirewalls,
    };
  });
}

export async function loadConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot> {
  const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const { state } = connectorRuntimeState(acceptedSnapshot, undefined);
  if (state.snapshot !== undefined) {
    return state.snapshot;
  }
  const connectorSlugs = acceptedSnapshot.artifact.connectors.map(
    (connector) => {
      return connector.slug;
    },
  );
  const snapshot: ConnectorRuntimeSnapshot = {
    acceptedSnapshot,
    catalogIdentity: acceptedSnapshot.identity,
    connectors: selectedRuntimeConnectors(state, connectorSlugs),
    serverFirewalls: state.serverFirewalls,
    serverFirewallMetadata: state.serverFirewalls,
  };
  state.snapshot = snapshot;
  return snapshot;
}

export function getConnectorRuntimeConnector(
  snapshot: ConnectorRuntimeSelection,
  connectorSlug: string,
): ConnectorRuntimeConnector | undefined {
  return snapshot.connectors.get(connectorSlug);
}

export function getConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly requireExecutable?: boolean;
}): ConnectorRuntimeMethod | undefined {
  const method = args.snapshot.connectors
    .get(args.connectorSlug)
    ?.methods.get(args.authMethodId);
  if (args.requireExecutable === true && method?.executable !== true) {
    return undefined;
  }
  return method;
}

export function listConnectorRuntimeVisibleSlugs(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorSlug[] {
  return listAcceptedConnectorCatalogAvailableSlugs({
    snapshot: args.snapshot.acceptedSnapshot,
    featureStates: args.featureStates,
  });
}
