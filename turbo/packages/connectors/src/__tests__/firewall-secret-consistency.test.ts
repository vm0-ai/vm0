import { describe, it, expect } from "vitest";
import { connectorTypeSchema, type ConnectorType } from "../connectors";
import {
  getConnectorEnvBindings,
  getConnectorManualGrantFieldNames,
} from "../connector-utils";
import { extractFirewallTemplateReferences } from "../firewall-types";
import { getConnectorFirewall, isFirewallConnectorType } from "../firewalls";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VAR_REF_PREFIX = "$vars.";

const PLATFORM_INJECTED_SECRET_NAMES: Partial<
  Record<string, readonly string[]>
> = {
  "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"],
};

interface ConnectorAuthSources {
  readonly secretBackedKeys: ReadonlySet<string>;
  readonly variableBackedKeys: ReadonlySet<string>;
}

function connectorAuthSources(
  connectorType: ConnectorType,
): ConnectorAuthSources {
  const secretBackedKeys = new Set<string>();
  const variableBackedKeys = new Set<string>();

  const envBindings = getConnectorEnvBindings(connectorType);
  const hasEnvBindings = Object.keys(envBindings).length > 0;

  if (hasEnvBindings) {
    for (const [envName, valueRef] of Object.entries(envBindings)) {
      if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
        secretBackedKeys.add(envName);
        secretBackedKeys.add(
          valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length),
        );
      } else if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
        variableBackedKeys.add(envName);
      }
    }
  } else {
    const manualFields = getConnectorManualGrantFieldNames(connectorType);
    manualFields?.secrets.forEach((name) => {
      secretBackedKeys.add(name);
    });
    manualFields?.variables.forEach((name) => {
      variableBackedKeys.add(name);
    });
  }

  for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
    secretBackedKeys.add(name);
  }

  return { secretBackedKeys, variableBackedKeys };
}

function connectorPlaceholderKeys(connectorType: ConnectorType): Set<string> {
  const placeholderKeys = new Set<string>();

  const envBindings = getConnectorEnvBindings(connectorType);
  const hasEnvBindings = Object.keys(envBindings).length > 0;

  if (hasEnvBindings) {
    for (const [envName, valueRef] of Object.entries(envBindings)) {
      placeholderKeys.add(envName);
      if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
        placeholderKeys.add(valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length));
      }
    }
  } else {
    const manualFields = getConnectorManualGrantFieldNames(connectorType);
    manualFields?.secrets.forEach((name) => {
      placeholderKeys.add(name);
    });
    manualFields?.variables.forEach((name) => {
      placeholderKeys.add(name);
    });
  }

  for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
    placeholderKeys.add(name);
  }

  return placeholderKeys;
}

/**
 * Verify that every builtin firewall's placeholder names match
 * the environment names exposed by the connector that references it.
 *
 * OAuth connectors expose environment names via derived env bindings (e.g. SLACK_TOKEN).
 * API-token connectors expose manual grant fields.
 * The firewall's `placeholders` keys must be a subset of these names,
 * otherwise the proxy won't find the secret to inject.
 */
describe("firewall secret name consistency", () => {
  const connectorTypes = connectorTypeSchema.options;

  for (const connectorType of connectorTypes) {
    if (!isFirewallConnectorType(connectorType)) continue;

    it(`${connectorType} → firewall placeholder keys match connector fields`, () => {
      const validPlaceholderKeys = connectorPlaceholderKeys(connectorType);

      const firewall = getConnectorFirewall(connectorType);
      const placeholderKeys = Object.keys(firewall.placeholders ?? {});
      for (const key of placeholderKeys) {
        expect(
          validPlaceholderKeys.has(key),
          `firewall "${connectorType}" placeholder "${key}" not found in ${connectorType} connector fields: [${[...validPlaceholderKeys].join(", ")}]`,
        ).toBe(true);
      }
    });

    it(`${connectorType} → firewall auth templates match connector value sources`, () => {
      const { secretBackedKeys, variableBackedKeys } =
        connectorAuthSources(connectorType);
      const firewall = getConnectorFirewall(connectorType);
      const references = extractFirewallTemplateReferences(firewall.apis);

      for (const key of references.secrets) {
        expect(
          secretBackedKeys.has(key),
          `firewall "${connectorType}" secrets.${key} is not backed by a connector secret: [${[...secretBackedKeys].join(", ")}]`,
        ).toBe(true);
      }
      for (const key of references.vars) {
        expect(
          variableBackedKeys.has(key),
          `firewall "${connectorType}" vars.${key} is not backed by a connector variable: [${[...variableBackedKeys].join(", ")}]`,
        ).toBe(true);
      }
    });
  }
});
