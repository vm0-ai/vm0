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
  for (const sensitiveValue of [
    "OPENAI_TOKEN",
    "NEON_TOKEN",
    "NEON_ACCESS_TOKEN",
    "NEON_REFRESH_TOKEN",
  ]) {
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
