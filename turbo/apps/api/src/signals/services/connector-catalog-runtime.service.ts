import { createHash } from "node:crypto";

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
  CONNECTOR_TYPE_KEYS,
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
} from "@vm0/connectors/connectors";
import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRuntimeMetadata,
  getConnectorAuthMethod,
  getRuntimeAvailableConnectorTypes,
  type ConnectorEnvReader,
  type ConnectorFeatureStates,
} from "@vm0/connectors/connector-utils";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { waitUntil } from "../context/wait-until";
import type { ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import type {
  ConnectorCatalogPrivateArtifact,
  ConnectorCatalogPublicArtifact,
} from "./connector-catalog-artifacts/artifacts";
import {
  acceptedConnectorCatalogMethodIsCompatible,
  ExternalConnectorCatalogUnavailableError,
  getAcceptedConnectorCatalogAvailableDetail,
  getAcceptedConnectorCatalogResolutionDetail,
  listAcceptedConnectorCatalogAvailableRefs,
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
import {
  getStaticConnectorCatalogResolutionDetail,
  getStaticPublicConnectorCatalogDetail,
} from "./connector-catalog-reader.service";
import {
  createExternalConnectorServerFirewallCatalog,
  createStaticConnectorServerFirewallCatalog,
  type ConnectorServerFirewallCatalog,
} from "./connector-server-firewall-catalog.service";

type AcceptedPrivateConnector =
  ConnectorCatalogPrivateArtifact["connectors"][number];
type AcceptedPrivateAuthMethod =
  AcceptedPrivateConnector["authMethods"][number];
type AcceptedPrivateSkill = AcceptedPrivateConnector["skill"];
type AcceptedPublicAuthMethod =
  ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number];

export type ConnectorRuntimeSnapshotIdentity =
  | { readonly source: "static" }
  | ({ readonly source: "external" } & ExternalCatalogIdentity);

export interface ConnectorRuntimeMethod {
  readonly connectorRef: ConnectorRef;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly availableForNewActions: boolean;
  readonly compatible: boolean;
  readonly executable: boolean;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}

export interface ConnectorRuntimeConnector {
  readonly connectorRef: ConnectorRef;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly methods: ReadonlyMap<ConnectorAuthMethodId, ConnectorRuntimeMethod>;
  readonly skill: AcceptedPrivateSkill | null;
}

interface ConnectorRuntimeSnapshotBase {
  readonly connectors: ReadonlyMap<ConnectorRef, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
}

export type ConnectorRuntimeSnapshot =
  | (ConnectorRuntimeSnapshotBase & {
      readonly identity: Extract<
        ConnectorRuntimeSnapshotIdentity,
        { readonly source: "static" }
      >;
      readonly acceptedSnapshot: null;
    })
  | (ConnectorRuntimeSnapshotBase & {
      readonly identity: Extract<
        ConnectorRuntimeSnapshotIdentity,
        { readonly source: "external" }
      >;
      readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
    });

const log = logger("connector-catalog:runtime-shadow");

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
  access: AcceptedPrivateAuthMethod["access"],
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
  client: AcceptedPrivateAuthMethod["client"],
): ConnectorAuthClientConfig | undefined {
  return client === undefined ? undefined : { ...client };
}

function requiredRuntimeClient(
  method: AcceptedPrivateAuthMethod,
): ConnectorAuthClientConfig {
  const client = runtimeClient(method.client);
  if (client === undefined) {
    throw new Error("Accepted connector auth method is missing its client");
  }
  return client;
}

function requiredPublicRuntimeClient(
  method: AcceptedPrivateAuthMethod,
): PublicConnectorAuthClientConfig {
  const client = requiredRuntimeClient(method);
  if (client.clientType !== "public") {
    throw new Error("Accepted device auth method requires a public client");
  }
  return client;
}

function manualGrant(args: {
  readonly publicMethod: AcceptedPublicAuthMethod;
  readonly privateMethod: AcceptedPrivateAuthMethod & {
    readonly grant: Extract<
      AcceptedPrivateAuthMethod["grant"],
      { kind: "manual" }
    >;
  };
}): Extract<ConnectorAuthMethodRuntimeConfig["grant"], { kind: "manual" }> {
  const fields: Record<
    string,
    Extract<
      ConnectorAuthMethodRuntimeConfig["grant"],
      { kind: "manual" }
    >["fields"][string]
  > = {};
  for (const privateField of args.privateMethod.grant.fields) {
    const publicField = args.publicMethod.manualFields.find((candidate) => {
      return candidate.id === privateField.publicId;
    });
    if (publicField === undefined) {
      throw new Error("Accepted connector manual field alignment is missing");
    }
    fields[privateField.privateName] = {
      publicId: privateField.publicId,
      label: publicField.label,
      required: publicField.required,
      ...(publicField.placeholder === null
        ? {}
        : { placeholder: publicField.placeholder }),
      storage: privateField.storage,
      ...(privateField.normalize === undefined
        ? {}
        : { normalize: privateField.normalize }),
    };
  }
  return { kind: "manual", fields };
}

function deviceStartOption(
  option: AcceptedPublicAuthMethod["startOptions"][number],
): ConnectorDeviceAuthStartOptionConfig {
  const [first, ...rest] = option.options;
  if (first === undefined) {
    throw new Error("Accepted connector device option has no choices");
  }
  return {
    kind: "select",
    publicId: option.id,
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

function deviceStartOptions(args: {
  readonly publicMethod: AcceptedPublicAuthMethod;
  readonly privateMethod: AcceptedPrivateAuthMethod & {
    readonly grant: Extract<
      AcceptedPrivateAuthMethod["grant"],
      { kind: "device-auth" }
    >;
  };
}): Readonly<Record<string, ConnectorDeviceAuthStartOptionConfig>> | undefined {
  const options: Record<string, ConnectorDeviceAuthStartOptionConfig> = {};
  for (const mapping of args.privateMethod.grant.startOptionMappings) {
    const publicOption = args.publicMethod.startOptions.find((candidate) => {
      return candidate.id === mapping.publicId;
    });
    if (publicOption === undefined) {
      throw new Error("Accepted connector device option alignment is missing");
    }
    options[mapping.privateName] = deviceStartOption(publicOption);
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function runtimeMethod(args: {
  readonly publicMethod: AcceptedPublicAuthMethod;
  readonly privateMethod: AcceptedPrivateAuthMethod;
}): ConnectorAuthMethodRuntimeConfig {
  const access = runtimeAccess(args.privateMethod.access);
  const revoke =
    args.privateMethod.revoke.kind === "none"
      ? { kind: "none" as const }
      : {
          kind: "token-revoke" as const,
          inputs: revokeInputBindings(args.privateMethod.revoke.inputs),
          ...(args.privateMethod.revoke.revokePreviousOnReplace === undefined
            ? {}
            : {
                revokePreviousOnReplace:
                  args.privateMethod.revoke.revokePreviousOnReplace,
              }),
        };
  const storage = {
    version: args.privateMethod.storage.version,
    secrets: [...args.privateMethod.storage.secrets],
    variables: [...args.privateMethod.storage.variables],
  };

  switch (args.privateMethod.grant.kind) {
    case "manual": {
      return {
        storage,
        grant: manualGrant({
          publicMethod: args.publicMethod,
          privateMethod: {
            ...args.privateMethod,
            grant: args.privateMethod.grant,
          },
        }),
        access,
        revoke,
        ...(args.privateMethod.client === undefined
          ? {}
          : { client: runtimeClient(args.privateMethod.client) }),
      };
    }
    case "auth-code": {
      return {
        client: requiredRuntimeClient(args.privateMethod),
        storage,
        grant: {
          kind: "auth-code",
          scopes: [...args.privateMethod.grant.scopes],
          callbackOrigin: args.privateMethod.grant.callbackOrigin,
          outputs: outputBindings(args.privateMethod.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "openid-auth": {
      return {
        ...(args.privateMethod.client === undefined
          ? {}
          : { client: runtimeClient(args.privateMethod.client) }),
        storage,
        grant: {
          kind: "openid-auth",
          callbackOrigin: args.privateMethod.grant.callbackOrigin,
          outputs: outputBindings(args.privateMethod.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "external-code": {
      return {
        client: requiredRuntimeClient(args.privateMethod),
        storage,
        grant: {
          kind: "external-code",
          scopes: [...args.privateMethod.grant.scopes],
          outputs: outputBindings(args.privateMethod.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "device-auth": {
      const startOptions = deviceStartOptions({
        publicMethod: args.publicMethod,
        privateMethod: {
          ...args.privateMethod,
          grant: args.privateMethod.grant,
        },
      });
      return {
        client: requiredPublicRuntimeClient(args.privateMethod),
        storage,
        grant: {
          kind: "device-auth",
          scopes: [...args.privateMethod.grant.scopes],
          outputs: outputBindings(args.privateMethod.grant.outputs),
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
  readonly availableForNewActions: boolean;
  readonly compatible: boolean;
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
    availableForNewActions: args.availableForNewActions,
    compatible: args.compatible,
    registration,
    executable:
      args.compatible &&
      registrationSupportsMethod({ method: args.method, registration }),
  };
}

const staticRuntimeSnapshot = singleton(() => {
  return (async (): Promise<ConnectorRuntimeSnapshot> => {
    const connectors = new Map<ConnectorRef, ConnectorRuntimeConnector>();
    for (const connectorRef of CONNECTOR_TYPE_KEYS) {
      const catalogConnector =
        await getStaticConnectorCatalogResolutionDetail(connectorRef);
      if (catalogConnector === null) {
        throw new Error(`Static connector catalog is missing ${connectorRef}`);
      }
      const methods = new Map<ConnectorAuthMethodId, ConnectorRuntimeMethod>();
      for (const catalogMethod of catalogConnector.authMethods) {
        const method = getConnectorAuthMethod(connectorRef, catalogMethod.id);
        if (method === undefined) {
          throw new Error(
            `Static connector auth method is missing ${connectorRef}:${catalogMethod.id}`,
          );
        }
        methods.set(
          catalogMethod.id,
          runtimeMethodEntry({
            connectorRef,
            catalogMethod,
            method,
            availableForNewActions: method.visible !== false,
            compatible: true,
          }),
        );
      }
      connectors.set(connectorRef, {
        connectorRef,
        catalogConnector,
        methods,
        skill: null,
      });
    }
    return {
      identity: { source: "static" },
      acceptedSnapshot: null,
      connectors,
      serverFirewalls:
        createStaticConnectorServerFirewallCatalog(CONNECTOR_TYPE_KEYS),
    };
  })();
});

function externalRuntimeSnapshot(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
): ConnectorRuntimeSnapshot {
  const privateByRef = new Map(
    acceptedSnapshot.privateArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const connectors = new Map<ConnectorRef, ConnectorRuntimeConnector>();

  for (const publicConnector of acceptedSnapshot.publicArtifact.connectors) {
    const privateConnector = privateByRef.get(publicConnector.connectorRef);
    const catalogConnector = getAcceptedConnectorCatalogResolutionDetail({
      snapshot: acceptedSnapshot,
      connectorRef: publicConnector.connectorRef,
    });
    if (privateConnector === undefined || catalogConnector === null) {
      throw new Error("Accepted connector runtime relationship is incomplete");
    }
    const privateMethods = new Map(
      privateConnector.authMethods.map((method) => {
        return [method.id, method];
      }),
    );
    const catalogMethods = new Map(
      catalogConnector.authMethods.map((method) => {
        return [method.id, method];
      }),
    );
    const methods = new Map<ConnectorAuthMethodId, ConnectorRuntimeMethod>();
    for (const publicMethod of publicConnector.authMethods) {
      const privateMethod = privateMethods.get(publicMethod.id);
      const catalogMethod = catalogMethods.get(publicMethod.id);
      if (privateMethod === undefined || catalogMethod === undefined) {
        throw new Error(
          "Accepted connector auth method alignment is incomplete",
        );
      }
      const method = runtimeMethod({ publicMethod, privateMethod });
      methods.set(
        publicMethod.id,
        runtimeMethodEntry({
          connectorRef: publicConnector.connectorRef,
          catalogMethod,
          method,
          availableForNewActions: publicMethod.visible,
          compatible: acceptedConnectorCatalogMethodIsCompatible({
            snapshot: acceptedSnapshot,
            connectorRef: publicConnector.connectorRef,
            authMethodId: publicMethod.id,
          }),
        }),
      );
    }
    connectors.set(publicConnector.connectorRef, {
      connectorRef: publicConnector.connectorRef,
      catalogConnector,
      methods,
      skill: privateConnector.skill,
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
  return {
    identity: { source: "external", ...acceptedSnapshot.identity },
    acceptedSnapshot,
    connectors,
    serverFirewalls: createExternalConnectorServerFirewallCatalog({
      publicArtifact: acceptedSnapshot.publicArtifact,
      privateFirewallsArtifact: acceptedSnapshot.privateFirewallsArtifact,
      runtimeMethodsByRef,
    }),
  };
}

function externalSnapshotKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.integrityDigest,
    identity.capabilityDigest,
  ].join("\0");
}

interface ExternalRuntimeSnapshotCache {
  key: string | undefined;
  snapshot: ConnectorRuntimeSnapshot | undefined;
}

const externalRuntimeSnapshotCache = singleton(
  (): ExternalRuntimeSnapshotCache => {
    return { key: undefined, snapshot: undefined };
  },
);

async function loadExternalRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot> {
  const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const key = externalSnapshotKey(acceptedSnapshot.identity);
  const cache = externalRuntimeSnapshotCache();
  if (cache.key === key && cache.snapshot !== undefined) {
    return cache.snapshot;
  }
  const snapshot = externalRuntimeSnapshot(acceptedSnapshot);
  cache.key = key;
  cache.snapshot = snapshot;
  return snapshot;
}

interface RuntimeShadowMethod {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly grantKind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"];
  readonly accessKind: ConnectorAuthMethodRuntimeConfig["access"]["kind"];
  readonly revokeKind: ConnectorAuthMethodRuntimeConfig["revoke"]["kind"];
  readonly availableForNewActions: boolean;
  readonly executable: boolean;
}

function runtimeShadowMethods(
  snapshot: ConnectorRuntimeSnapshot,
): readonly RuntimeShadowMethod[] {
  return [...snapshot.connectors.values()]
    .flatMap((connector) => {
      return [...connector.methods.values()].map((method) => {
        return {
          connectorRef: method.connectorRef,
          authMethodId: method.authMethodId,
          grantKind: method.method.grant.kind,
          accessKind: method.method.access.kind,
          revokeKind: method.method.revoke.kind,
          availableForNewActions: method.availableForNewActions,
          executable: method.executable,
        };
      });
    })
    .sort((left, right) => {
      return (
        left.connectorRef.localeCompare(right.connectorRef) ||
        left.authMethodId.localeCompare(right.authMethodId)
      );
    });
}

function runtimeShadowDigest(methods: readonly RuntimeShadowMethod[]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(methods))
    .digest("hex")}`;
}

async function serverFirewallShadowDigest(
  snapshot: ConnectorRuntimeSnapshot,
): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(await snapshot.serverFirewalls.shadowProjection()))
    .digest("hex")}`;
}

async function compareRuntimeSnapshots(
  staticSnapshot: ConnectorRuntimeSnapshot,
  db: ReadonlyDb,
): Promise<void> {
  const result = await settle(loadExternalRuntimeSnapshot(db));
  if (!result.ok) {
    log.warn("Connector runtime catalog shadow comparison unavailable", {
      type: "connector_runtime_catalog_shadow_comparison",
      outcome:
        result.error instanceof ExternalConnectorCatalogUnavailableError
          ? "unavailable"
          : "error",
    });
    return;
  }
  const staticMethods = runtimeShadowMethods(staticSnapshot);
  const externalMethods = runtimeShadowMethods(result.value);
  const staticDigest = runtimeShadowDigest(staticMethods);
  const externalDigest = runtimeShadowDigest(externalMethods);
  const [staticServerFirewallDigest, externalServerFirewallDigest] =
    await Promise.all([
      serverFirewallShadowDigest(staticSnapshot),
      serverFirewallShadowDigest(result.value),
    ]);
  log.debug("Connector runtime catalog shadow comparison completed", {
    type: "connector_runtime_catalog_shadow_comparison",
    outcome:
      staticDigest === externalDigest &&
      staticServerFirewallDigest === externalServerFirewallDigest
        ? "match"
        : "difference",
    staticConnectorCount: staticSnapshot.connectors.size,
    externalConnectorCount: result.value.connectors.size,
    staticMethodCount: staticMethods.length,
    externalMethodCount: externalMethods.length,
    staticDigest,
    externalDigest,
    staticServerFirewallCount:
      staticSnapshot.serverFirewalls.connectorRefs.length,
    externalServerFirewallCount:
      result.value.serverFirewalls.connectorRefs.length,
    staticServerFirewallDigest,
    externalServerFirewallDigest,
    ...(result.value.identity.source === "external"
      ? {
          sourceId: result.value.identity.sourceId,
          schemaVersion: result.value.identity.schemaVersion,
          catalogVersion: result.value.identity.catalogVersion,
          integrityDigest: result.value.identity.integrityDigest,
          capabilityDigest: result.value.identity.capabilityDigest,
        }
      : {}),
  });
}

export async function loadConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot> {
  const sourceMode = env("CONNECTOR_CATALOG_SOURCE_MODE");
  if (sourceMode === "external") {
    return await loadExternalRuntimeSnapshot(db);
  }
  const snapshot = await staticRuntimeSnapshot();
  if (sourceMode === "shadow") {
    waitUntil(compareRuntimeSnapshots(snapshot, db));
  }
  return snapshot;
}

export function getConnectorRuntimeConnector(
  snapshot: ConnectorRuntimeSnapshot,
  connectorRef: string,
): ConnectorRuntimeConnector | undefined {
  return snapshot.connectors.get(connectorRef);
}

export function getConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
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

async function getConnectorRuntimeAvailableCatalogDetail(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorRef: string;
  readonly featureStates: ConnectorFeatureStates;
}): Promise<PublicConnectorCatalogDetail | null> {
  if (args.snapshot.identity.source === "external") {
    const acceptedSnapshot = args.snapshot.acceptedSnapshot;
    if (acceptedSnapshot === null) {
      throw new Error("External connector runtime snapshot is incomplete");
    }
    return getAcceptedConnectorCatalogAvailableDetail({
      snapshot: acceptedSnapshot,
      connectorRef: args.connectorRef,
      featureStates: args.featureStates,
    });
  }
  return await getStaticPublicConnectorCatalogDetail({
    connectorRef: args.connectorRef,
    featureStates: args.featureStates,
    apiAuthMethodPolicy: "include",
  });
}

export async function listConnectorRuntimeVisibleRefs(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): Promise<readonly ConnectorRef[]> {
  if (args.snapshot.identity.source === "external") {
    const acceptedSnapshot = args.snapshot.acceptedSnapshot;
    if (acceptedSnapshot === null) {
      throw new Error("External connector runtime snapshot is incomplete");
    }
    return listAcceptedConnectorCatalogAvailableRefs({
      snapshot: acceptedSnapshot,
      featureStates: args.featureStates,
    });
  }
  const refs: ConnectorRef[] = [];
  for (const connector of args.snapshot.connectors.values()) {
    const available = await getConnectorRuntimeAvailableCatalogDetail({
      snapshot: args.snapshot,
      connectorRef: connector.connectorRef,
      featureStates: args.featureStates,
    });
    if (available !== null) {
      refs.push(connector.connectorRef);
    }
  }
  return refs.sort();
}

export function filterConnectorRuntimeConfiguredRefs(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly visibleRefs: readonly ConnectorRef[];
  readonly readEnv: ConnectorEnvReader;
}): readonly ConnectorRef[] {
  if (args.snapshot.identity.source === "external") {
    return args.visibleRefs;
  }
  const configuredRefs = new Set<string>(
    getRuntimeAvailableConnectorTypes(args.readEnv),
  );
  return args.visibleRefs.filter((connectorRef) => {
    return configuredRefs.has(connectorRef);
  });
}
