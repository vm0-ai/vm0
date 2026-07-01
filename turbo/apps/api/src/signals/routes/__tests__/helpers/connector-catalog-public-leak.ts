import { CONNECTOR_TYPE_KEYS } from "@vm0/connectors/connectors";
import { getConnectorPrivateNames } from "@vm0/connectors/connector-utils";

interface SensitiveStringValues {
  readonly byConnector: ReadonlyMap<string, ReadonlySet<string>>;
  readonly global: ReadonlySet<string>;
}

function sensitiveStringValues(): SensitiveStringValues {
  const valuesByConnector = new Map<string, Set<string>>();

  for (const connectorType of CONNECTOR_TYPE_KEYS) {
    valuesByConnector.set(
      connectorType,
      new Set(getConnectorPrivateNames(connectorType)),
    );
  }

  return {
    byConnector: valuesByConnector,
    global: new Set(
      [...valuesByConnector.values()].flatMap((values) => {
        return [...values];
      }),
    ),
  };
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

function assertNoSensitiveString(
  value: string,
  path: string,
  sensitiveValues: SensitiveStringValues,
  connectorSensitiveValues: ReadonlySet<string> | undefined,
): void {
  const normalizedValue = normalizeSensitiveString(value);
  for (const sensitiveValue of sensitiveValues.global) {
    if (value.includes(sensitiveValue)) {
      throw new Error(
        `Public connector catalog response leaked ${sensitiveValue} at ${path}`,
      );
    }
  }
  if (!connectorSensitiveValues || !shouldCheckDerivedSensitiveValue(path)) {
    return;
  }
  for (const sensitiveValue of connectorSensitiveValues) {
    const normalizedSensitiveValue = normalizeSensitiveString(sensitiveValue);
    if (
      sensitiveValue.includes("_") &&
      normalizedSensitiveValue.length >= 8 &&
      normalizedValue.includes(normalizedSensitiveValue)
    ) {
      throw new Error(
        `Public connector catalog response leaked ${sensitiveValue} at ${path}`,
      );
    }
  }
}

function assertNoSensitiveProperties(
  value: object,
  path: string,
  sensitiveValues: SensitiveStringValues,
  connectorSensitiveValues: ReadonlySet<string> | undefined,
): void {
  const nextConnectorSensitiveValues =
    "connectorRef" in value && typeof value.connectorRef === "string"
      ? sensitiveValues.byConnector.get(value.connectorRef)
      : connectorSensitiveValues;

  for (const [key, child] of Object.entries(value)) {
    if (isSensitivePropertyName(key)) {
      throw new Error(
        `Public connector catalog response leaked private property ${key} at ${path}`,
      );
    }
    assertPublicConnectorCatalogHasNoPrivateFields(
      child,
      `${path}.${key}`,
      sensitiveValues,
      nextConnectorSensitiveValues,
    );
  }
}

export function assertPublicConnectorCatalogHasNoPrivateFields(
  value: unknown,
  path = "$",
  sensitiveValues: SensitiveStringValues = sensitiveStringValues(),
  connectorSensitiveValues?: ReadonlySet<string>,
): void {
  if (typeof value === "string") {
    assertNoSensitiveString(
      value,
      path,
      sensitiveValues,
      connectorSensitiveValues,
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertPublicConnectorCatalogHasNoPrivateFields(
        child,
        `${path}[${index}]`,
        sensitiveValues,
        connectorSensitiveValues,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    assertNoSensitiveProperties(
      value,
      path,
      sensitiveValues,
      connectorSensitiveValues,
    );
  }
}
