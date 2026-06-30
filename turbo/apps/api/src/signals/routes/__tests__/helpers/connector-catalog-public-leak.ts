import {
  CONNECTOR_AUTH_METHOD_IDS,
  CONNECTOR_TYPE_KEYS,
  type ConnectorAuthMethodConfig,
} from "@vm0/connectors/connectors";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";

function addValueRefName(valueRef: string, values: Set<string>): void {
  const match = /^\$(?:secrets|vars)\.(.+)$/.exec(valueRef);
  if (match?.[1]) {
    values.add(match[1]);
  }
}

function addAuthMethodStorageNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  for (const secret of method.storage.secrets) {
    values.add(secret);
  }
  for (const variable of method.storage.variables) {
    values.add(variable);
  }
}

function addAuthMethodGrantNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  if (method.grant.kind === "manual") {
    for (const fieldName of Object.keys(method.grant.fields)) {
      values.add(fieldName);
    }
  }
  if ("outputs" in method.grant) {
    for (const valueRef of Object.values(method.grant.outputs)) {
      addValueRefName(valueRef, values);
    }
  }
}

function addAuthMethodAccessNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  if (method.access.kind === "none") {
    return;
  }

  for (const [envName, binding] of Object.entries(method.access.envBindings)) {
    values.add(envName);
    addValueRefName(
      typeof binding === "string" ? binding : binding.valueRef,
      values,
    );
  }
  for (const platformSecret of method.access.platformSecrets ?? []) {
    values.add(platformSecret);
  }
}

function addAuthMethodRefreshNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  if (method.access.kind !== "refresh-token") {
    return;
  }

  for (const valueRef of Object.values(method.access.inputs)) {
    addValueRefName(valueRef, values);
  }
  for (const valueRef of Object.values(method.access.outputs)) {
    addValueRefName(valueRef, values);
  }
  for (const refreshableSecret of method.access.refreshableSecrets) {
    values.add(refreshableSecret);
  }
}

function addAuthMethodRevokeNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  if (method.revoke.kind !== "token-revoke") {
    return;
  }

  for (const valueRef of Object.values(method.revoke.inputs)) {
    addValueRefName(valueRef, values);
  }
}

function addAuthMethodClientNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  if (!("client" in method) || !method.client) {
    return;
  }

  if ("clientIdEnv" in method.client) {
    values.add(method.client.clientIdEnv);
  }
  if ("clientSecretEnv" in method.client) {
    values.add(method.client.clientSecretEnv);
  }
}

function addAuthMethodSensitiveNames(
  method: ConnectorAuthMethodConfig,
  values: Set<string>,
): void {
  addAuthMethodStorageNames(method, values);
  addAuthMethodGrantNames(method, values);
  addAuthMethodAccessNames(method, values);
  addAuthMethodRefreshNames(method, values);
  addAuthMethodRevokeNames(method, values);
  addAuthMethodClientNames(method, values);
}

function sensitiveStringValues(): Set<string> {
  const values = new Set<string>();

  for (const connectorType of CONNECTOR_TYPE_KEYS) {
    for (const authMethodId of CONNECTOR_AUTH_METHOD_IDS) {
      const method = getConnectorAuthMethod(connectorType, authMethodId);
      if (method) {
        addAuthMethodSensitiveNames(method, values);
      }
    }
  }

  return values;
}

const SENSITIVE_STRING_VALUES = sensitiveStringValues();

function isSensitivePropertyName(key: string): boolean {
  return [
    "storage",
    "secrets",
    "variables",
    "envBindings",
    "valueRef",
    "source",
    "target",
    "platformSecrets",
    "client",
    "clientIdEnv",
    "clientSecretEnv",
    "clientSecret",
    "scopes",
    "outputs",
    "inputs",
    "refreshableSecrets",
    "revoke",
    "access",
    "featureFlag",
    "showExperimentalLabel",
    "placeholderValues",
    "baseUrlTemplates",
    "secretPlaceholderNames",
    "manifestKey",
    "bucket",
    "objectKey",
    "signedUrl",
  ].includes(key);
}

function assertNoSensitiveString(value: string, path: string): void {
  for (const sensitiveValue of SENSITIVE_STRING_VALUES) {
    if (value.includes(sensitiveValue)) {
      throw new Error(
        `Public connector catalog response leaked ${sensitiveValue} at ${path}`,
      );
    }
  }
}

function assertNoSensitiveProperties(value: object, path: string): void {
  for (const [key, child] of Object.entries(value)) {
    if (isSensitivePropertyName(key)) {
      throw new Error(
        `Public connector catalog response leaked private property ${key} at ${path}`,
      );
    }
    assertPublicConnectorCatalogHasNoPrivateFields(child, `${path}.${key}`);
  }
}

export function assertPublicConnectorCatalogHasNoPrivateFields(
  value: unknown,
  path = "$",
): void {
  if (typeof value === "string") {
    assertNoSensitiveString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertPublicConnectorCatalogHasNoPrivateFields(
        child,
        `${path}[${index}]`,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    assertNoSensitiveProperties(value, path);
  }
}
