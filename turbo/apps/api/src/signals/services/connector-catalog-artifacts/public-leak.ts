import type { ConnectorCatalogPrivateArtifact } from "./schemas";

function isForbiddenPublicPropertyName(key: string): boolean {
  return /^(storage|secrets|variables|envBindings|valueRef|source|target|platformSecrets|client|clientIdEnv|clientSecretEnv|clientSecret|scopes|outputs|inputs|refreshableSecrets|revoke|access|featureFlag|showExperimentalLabel|placeholderValues|baseUrlTemplates|secretPlaceholderNames|manifestKey|bucket|objectKey|signedUrl|runtimeArtifactRefs|runtimeName|privateName|authInjection|matcher|routing)$/.test(
    key,
  );
}

function normalizeSensitiveString(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
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

export function privateCatalogArtifactSensitiveValues(
  privateArtifact: ConnectorCatalogPrivateArtifact,
): ReadonlySet<string> {
  const values = new Set<string>();

  for (const connector of privateArtifact.connectors) {
    for (const artifactRef of connector.runtimeArtifactRefs) {
      values.add(artifactRef.key);
    }
    for (const authMethod of connector.authMethods) {
      for (const mapping of authMethod.manualFieldMappings) {
        values.add(mapping.privateName);
        values.add(mapping.runtimeName);
      }
      for (const mapping of authMethod.startOptionMappings) {
        values.add(mapping.privateName);
        values.add(mapping.runtimeName);
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

  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenPublicPropertyName(key)) {
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
