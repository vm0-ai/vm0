import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "./artifacts";
import {
  isPrivateTokenLikeKey,
  privateTokenMatches,
} from "./private-token-patterns";
import { deriveConnectorCatalogFirewallPermissions } from "./relationships";

const forbiddenPublicPropertyNamePattern =
  /^(access|client|clientId|clientIdEnv|clientSecret|clientSecretEnv|envBindings|featureFlag|inputs|objectKey|outputs|platformSecrets|privateName|refreshableSecrets|revoke|r2Key|scopes|secret|secrets|showExperimentalLabel|skillRef|sourcePath|storage|storageName|storageVersionPrefix|variables|valueRef|versionId)$/u;

function normalizeSensitiveString(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
}

function shouldCheckDerivedSensitiveValue(path: string): boolean {
  return (
    path.endsWith(".placeholder") ||
    path.endsWith(".defaultValue") ||
    path.endsWith(".value")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSensitiveValue(value: string, values: Set<string>): void {
  values.add(value);
  for (const match of privateTokenMatches(value)) {
    values.add(match);
  }
}

function addValueRef(valueRef: string, values: Set<string>): void {
  addSensitiveValue(valueRef, values);
  const separator = valueRef.indexOf(".");
  addSensitiveValue(valueRef.slice(separator + 1), values);
}

function addBindingValues(
  bindings: Readonly<Record<string, string>>,
  values: Set<string>,
): void {
  for (const valueRef of Object.values(bindings)) {
    addValueRef(valueRef, values);
  }
}

function connectorCatalogSensitiveValues(
  connector: ConnectorCatalogArtifactConnector,
): ReadonlySet<string> {
  const values = new Set<string>();
  if (connector.skill.kind === "bundled") {
    addSensitiveValue(connector.skill.storageName, values);
    addSensitiveValue(connector.skill.versionId, values);
    addSensitiveValue(connector.skill.storageVersionPrefix, values);
  }
  for (const authMethod of connector.authMethods) {
    for (const name of authMethod.storage.secrets) {
      addSensitiveValue(name, values);
    }
    for (const name of authMethod.storage.variables) {
      addSensitiveValue(name, values);
    }
    if (authMethod.client?.clientRegistration === "static") {
      if (authMethod.client.clientType === "confidential") {
        addSensitiveValue(authMethod.client.clientIdEnv, values);
        addSensitiveValue(authMethod.client.clientSecretEnv, values);
      } else {
        addSensitiveValue(authMethod.client.clientId, values);
      }
    }
    if (authMethod.grant.kind === "manual") {
      for (const field of authMethod.grant.fields) {
        addSensitiveValue(field.privateName, values);
      }
    } else {
      addBindingValues(authMethod.grant.outputs, values);
    }
    for (const [name, binding] of Object.entries(
      authMethod.access.envBindings,
    )) {
      addSensitiveValue(name, values);
      addValueRef(
        typeof binding === "string" ? binding : binding.valueRef,
        values,
      );
    }
    for (const name of authMethod.access.platformSecrets ?? []) {
      addSensitiveValue(name, values);
    }
    if (authMethod.access.kind === "refresh-token") {
      addBindingValues(authMethod.access.inputs, values);
      addBindingValues(authMethod.access.outputs, values);
      for (const name of authMethod.access.refreshableSecrets) {
        addSensitiveValue(name, values);
      }
    }
    if (authMethod.revoke.kind === "token-revoke") {
      addBindingValues(authMethod.revoke.inputs, values);
    }
  }
  return values;
}

function assertNoSensitiveString(args: {
  readonly value: string;
  readonly path: string;
  readonly sensitiveValues: ReadonlySet<string>;
}): void {
  const normalizedValue = normalizeSensitiveString(args.value);
  for (const sensitiveValue of args.sensitiveValues) {
    if (sensitiveValue.length === 0) {
      continue;
    }
    if (args.value.includes(sensitiveValue)) {
      throw new Error(
        `Public connector catalog projection leaked private value at ${args.path}`,
      );
    }
    const normalizedSensitiveValue = normalizeSensitiveString(sensitiveValue);
    if (
      shouldCheckDerivedSensitiveValue(args.path) &&
      sensitiveValue.includes("_") &&
      normalizedSensitiveValue.length >= 8 &&
      normalizedValue.includes(normalizedSensitiveValue)
    ) {
      throw new Error(
        `Public connector catalog projection leaked private value at ${args.path}`,
      );
    }
  }
}

function assertPublicValueHasNoPrivateFields(
  value: unknown,
  sensitiveValues: ReadonlySet<string>,
  path = "$",
): void {
  if (typeof value === "string") {
    assertNoSensitiveString({ value, path, sensitiveValues });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertPublicValueHasNoPrivateFields(
        child,
        sensitiveValues,
        `${path}[${index}]`,
      );
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const allowsPublicMapKeys = path.endsWith(".byPermission");
  for (const [key, child] of Object.entries(value)) {
    if (
      !allowsPublicMapKeys &&
      (forbiddenPublicPropertyNamePattern.test(key) ||
        isPrivateTokenLikeKey(key))
    ) {
      throw new Error(
        `Public connector catalog projection leaked private property ${key} at ${path}`,
      );
    }
    assertPublicValueHasNoPrivateFields(
      child,
      sensitiveValues,
      `${path}.${key}`,
    );
  }
}

function publicFirewall(connector: ConnectorCatalogArtifactConnector): unknown {
  if (connector.firewall.kind === "none") {
    return connector.firewall;
  }
  return {
    kind: "generated",
    permissions: deriveConnectorCatalogFirewallPermissions(
      connector.firewall.config.apis,
    ),
    categories: connector.firewall.categories,
    defaultAllowed: connector.firewall.defaultAllowed,
    defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
  };
}

function publicGrant(
  method: ConnectorCatalogArtifactConnector["authMethods"][number],
) {
  switch (method.grant.kind) {
    case "manual": {
      return {
        kind: method.grant.kind,
        fields: method.grant.fields.map((field) => {
          return {
            id: field.publicId,
            label: field.label,
            required: field.required,
            placeholder: field.placeholder,
            inputType: field.storage === "secret" ? "password" : "text",
          };
        }),
      };
    }
    case "device-auth": {
      return {
        kind: method.grant.kind,
        startOptions: method.grant.startOptions.map((option) => {
          return {
            id: option.publicId,
            kind: option.kind,
            label: option.label,
            required: option.required,
            defaultValue: option.defaultValue,
            options: option.options,
          };
        }),
      };
    }
    case "auth-code":
    case "external-code":
    case "openid-auth": {
      return { kind: method.grant.kind };
    }
  }
}

function publicConnector(connector: ConnectorCatalogArtifactConnector) {
  return {
    connectorRef: connector.connectorRef,
    label: connector.label,
    description: connector.description,
    category: connector.category,
    generation: connector.generation,
    tags: connector.tags,
    authMethods: connector.authMethods.map((method) => {
      return {
        id: method.id,
        label: method.label,
        description: method.description,
        visible: method.visible,
        featureSwitch: method.featureSwitch,
        grant: publicGrant(method),
      };
    }),
    icon: connector.icon,
    firewall: publicFirewall(connector),
  };
}

export function validateConnectorCatalogPublicProjection(
  artifact: ConnectorCatalogArtifact,
): void {
  assertPublicValueHasNoPrivateFields(
    {
      artifactSchemaVersion: artifact.artifactSchemaVersion,
      catalogVersion: artifact.catalogVersion,
      categoryMetadata: artifact.categoryMetadata,
    },
    new Set(),
  );
  for (const connector of artifact.connectors) {
    assertPublicValueHasNoPrivateFields(
      publicConnector(connector),
      connectorCatalogSensitiveValues(connector),
      `$.connectors[${connector.connectorRef}]`,
    );
  }
}
