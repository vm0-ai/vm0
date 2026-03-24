import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import {
  getConnectorEnvironmentMapping,
  getConnectorAuthMethods,
} from "../connectors";
import { getFirewallRefsForConnector } from "../firewalls";
import { builtinFirewalls } from "../../firewalls";

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
    const refs = getFirewallRefsForConnector(connectorType);
    if (refs.length === 0) continue;

    it(`${connectorType} → firewall placeholder keys match connector secret names`, () => {
      // Collect all secret/env var names the connector exposes
      const connectorSecretNames = new Set<string>();

      // From environmentMapping (OAuth path)
      const mapping = getConnectorEnvironmentMapping(connectorType);
      for (const envVar of Object.keys(mapping)) {
        connectorSecretNames.add(envVar);
      }

      // From authMethods secrets (API-token path)
      const authMethods = getConnectorAuthMethods(connectorType);
      for (const method of Object.values(authMethods)) {
        for (const name of Object.keys(method.secrets)) {
          connectorSecretNames.add(name);
        }
      }

      // Check each firewall ref's placeholder keys
      for (const ref of refs) {
        const firewall = builtinFirewalls[ref];
        expect(firewall, `builtin firewall "${ref}" not found`).toBeDefined();

        const placeholderKeys = Object.keys(firewall!.placeholders ?? {});
        for (const key of placeholderKeys) {
          expect(
            connectorSecretNames.has(key),
            `firewall "${ref}" placeholder "${key}" not found in ${connectorType} connector secrets: [${[...connectorSecretNames].join(", ")}]`,
          ).toBe(true);
        }
      }
    });
  }
});
