import { describe, it, expect } from "vitest";
import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorType,
} from "../connectors";
import { getConnectorEnvBindings } from "../connector-utils";
import { extractAuthNamesFromApis } from "../firewall-types";
import { getConnectorFirewall, isFirewallConnectorType } from "../firewalls";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VAR_REF_PREFIX = "$vars.";

const PLATFORM_INJECTED_SECRET_NAMES: Partial<
  Record<string, readonly string[]>
> = {
  "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"],
};

type AuthValueSource = "secret" | "variable" | "static";

interface ConnectorAuthKeys {
  readonly authValueSources: ReadonlyMap<string, AuthValueSource>;
  readonly placeholderKeys: ReadonlySet<string>;
}

function setAuthValueSource(
  sources: Map<string, AuthValueSource>,
  key: string,
  source: AuthValueSource,
): void {
  if (sources.get(key) === "secret") {
    return;
  }
  sources.set(key, source);
}

function connectorAuthKeys(connectorType: ConnectorType): ConnectorAuthKeys {
  const authValueSources = new Map<string, AuthValueSource>();
  const placeholderKeys = new Set<string>();

  const envBindings = getConnectorEnvBindings(connectorType);
  const hasEnvBindings = Object.keys(envBindings).length > 0;

  for (const [envName, valueRef] of Object.entries(envBindings)) {
    placeholderKeys.add(envName);

    if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
      const secretName = valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
      setAuthValueSource(authValueSources, envName, "secret");
      placeholderKeys.add(secretName);
    } else if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
      setAuthValueSource(authValueSources, envName, "variable");
    } else {
      setAuthValueSource(authValueSources, envName, "static");
    }
  }

  if (!hasEnvBindings) {
    for (const method of Object.values(
      CONNECTOR_TYPES[connectorType].authMethods,
    )) {
      if (method.grant.kind !== "manual") {
        continue;
      }
      for (const name of Object.keys(method.grant.fields)) {
        setAuthValueSource(authValueSources, name, "secret");
        placeholderKeys.add(name);
      }
    }
  }

  for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
    setAuthValueSource(authValueSources, name, "secret");
    placeholderKeys.add(name);
  }

  return { authValueSources, placeholderKeys };
}

/**
 * Verify that every builtin firewall's placeholder secret names match
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

    it(`${connectorType} → firewall placeholder keys match connector secret names`, () => {
      // Collect environment names the connector exposes.
      // If envBindings exists (OAuth), use ONLY those keys because
      // internal token storage names are not always firewall placeholders.
      const { placeholderKeys: connectorPlaceholderKeys } =
        connectorAuthKeys(connectorType);

      const firewall = getConnectorFirewall(connectorType);
      const firewallPlaceholderKeys = Object.keys(firewall.placeholders ?? {});
      for (const key of firewallPlaceholderKeys) {
        expect(
          connectorPlaceholderKeys.has(key),
          `firewall "${connectorType}" placeholder "${key}" not found in ${connectorType} connector auth keys: [${[...connectorPlaceholderKeys].join(", ")}]`,
        ).toBe(true);
      }
    });

    it(`${connectorType} → firewall auth keys are populated by run creation`, () => {
      const { authValueSources } = connectorAuthKeys(connectorType);
      const firewall = getConnectorFirewall(connectorType);
      const authNames = extractAuthNamesFromApis(firewall.apis);

      for (const key of authNames) {
        expect(
          authValueSources.has(key),
          `firewall "${connectorType}" auth key "${key}" not found in run-created auth values: [${[...authValueSources.keys()].join(", ")}]`,
        ).toBe(true);
      }
    });

    it(`${connectorType} → secret-backed firewall auth keys have placeholders`, () => {
      const { authValueSources } = connectorAuthKeys(connectorType);
      const firewall = getConnectorFirewall(connectorType);
      const authNames = extractAuthNamesFromApis(firewall.apis);
      const placeholders = firewall.placeholders ?? {};

      for (const key of authNames) {
        if (authValueSources.get(key) !== "secret") {
          continue;
        }
        expect(
          Object.hasOwn(placeholders, key),
          `firewall "${connectorType}" secret-backed auth key "${key}" needs a placeholder`,
        ).toBe(true);
      }
    });
  }
});
