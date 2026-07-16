import type { ConnectorCatalogPrivateArtifact } from "./artifacts";
import {
  isPrivateTokenLikeKey,
  privateTokenMatches,
} from "./private-token-patterns";

const forbiddenPublicPropertyNamePattern =
  /^(access|client|clientId|clientIdEnv|clientSecret|clientSecretEnv|envBindings|featureFlag|inputs|objectKey|outputs|platformSecrets|privateName|refreshableSecrets|revoke|r2Key|scopes|secret|secrets|showExperimentalLabel|skillRef|sourcePath|storage|variables|valueRef)$/u;

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

export function privateCatalogArtifactSensitiveValues(
  artifact: ConnectorCatalogPrivateArtifact,
): ReadonlySet<string> {
  const values = new Set<string>();
  for (const connector of artifact.connectors) {
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
        `Public connector catalog artifact leaked private value at ${args.path}`,
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
        `Public connector catalog artifact leaked private value at ${args.path}`,
      );
    }
  }
}

export function assertPublicCatalogArtifactHasNoPrivateFields(
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
      assertPublicCatalogArtifactHasNoPrivateFields(
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
        `Public connector catalog artifact leaked private property ${key} at ${path}`,
      );
    }
    assertPublicCatalogArtifactHasNoPrivateFields(
      child,
      sensitiveValues,
      `${path}.${key}`,
    );
  }
}
