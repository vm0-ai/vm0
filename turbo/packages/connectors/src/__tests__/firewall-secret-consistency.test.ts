import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import {
  getConnectorEnvironmentMapping,
  getConnectorAuthMethods,
} from "../connector-utils";
import { getConnectorFirewall, isFirewallConnectorType } from "../firewalls";

const PLATFORM_INJECTED_SECRET_NAMES: Partial<
  Record<string, readonly string[]>
> = {
  "google-ads": ["GOOGLE_ADS_DEVELOPER_TOKEN"],
};

/**
 * Verify that every builtin firewall's placeholder secret names match
 * the env var names exposed by the connector that references it.
 *
 * OAuth connectors expose env vars via `environmentMapping` (e.g. SLACK_TOKEN).
 * API-token connectors expose secrets via `authMethods["api-token"].secrets`.
 * The firewall's `placeholders` keys must be a subset of these names,
 * otherwise the proxy won't find the secret to inject.
 */
describe("firewall secret name consistency", () => {
  const connectorTypes = connectorTypeSchema.options;

  for (const connectorType of connectorTypes) {
    if (!isFirewallConnectorType(connectorType)) continue;

    it(`${connectorType} → firewall placeholder keys match connector secret names`, () => {
      // Collect env var names the connector exposes.
      // If environmentMapping exists (OAuth), use ONLY those keys —
      // authMethods.secrets holds internal names that the firewall must NOT use.
      const connectorSecretNames = new Set<string>();

      const mapping = getConnectorEnvironmentMapping(connectorType);
      const hasMapping = Object.keys(mapping).length > 0;

      if (hasMapping) {
        for (const [envVar, valueRef] of Object.entries(mapping)) {
          connectorSecretNames.add(envVar);
          // Also allow the raw secret name (e.g. GITHUB_ACCESS_TOKEN)
          if (valueRef.startsWith("$secrets.")) {
            connectorSecretNames.add(valueRef.slice("$secrets.".length));
          }
        }
      } else {
        // API-token path: use authMethods secrets directly
        const authMethods = getConnectorAuthMethods(connectorType);
        for (const method of Object.values(authMethods)) {
          for (const name of Object.keys(method.secrets)) {
            connectorSecretNames.add(name);
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
