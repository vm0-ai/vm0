import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import {
  getConnectorAuthMethods,
  getConnectorEnvBindings,
} from "../connector-utils";
import { getConnectorFirewall, isFirewallConnectorType } from "../firewalls";

const PLATFORM_INJECTED_SECRET_NAMES: Partial<
  Record<string, readonly string[]>
> = {
  "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"],
};

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
      const connectorSecretNames = new Set<string>();

      const envBindings = getConnectorEnvBindings(connectorType);
      const hasEnvBindings = Object.keys(envBindings).length > 0;

      if (hasEnvBindings) {
        for (const [envName, valueRef] of Object.entries(envBindings)) {
          connectorSecretNames.add(envName);
          // Also allow the raw secret name (e.g. GITHUB_ACCESS_TOKEN)
          if (valueRef.startsWith("$secrets.")) {
            connectorSecretNames.add(valueRef.slice("$secrets.".length));
          }
        }
      } else {
        // API-token path: use manual grant fields directly.
        for (const method of Object.values(
          getConnectorAuthMethods(connectorType),
        )) {
          switch (method.grant.kind) {
            case "manual":
              for (const name of Object.keys(method.grant.fields)) {
                connectorSecretNames.add(name);
              }
              break;
            case "managed":
            case "auth-code":
            case "device-auth":
              break;
          }
        }
      }
      for (const name of PLATFORM_INJECTED_SECRET_NAMES[connectorType] ?? []) {
        connectorSecretNames.add(name);
      }

      const firewall = getConnectorFirewall(connectorType);
      const placeholderKeys = Object.keys(firewall.placeholders ?? {});
      for (const key of placeholderKeys) {
        expect(
          connectorSecretNames.has(key),
          `firewall "${connectorType}" placeholder "${key}" not found in ${connectorType} connector secrets: [${[...connectorSecretNames].join(", ")}]`,
        ).toBe(true);
      }
    });
  }
});
