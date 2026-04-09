import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import { isFirewallConnectorType, getConnectorFirewall } from "../../firewalls";
import { validateRule } from "../firewall-expander";

/**
 * Validate that every rule in every builtin connector firewall passes
 * the same validation that custom (user-supplied) firewalls go through.
 *
 * This catches issues like query strings or fragments sneaking in via
 * OpenAPI specs during code generation.
 */
describe("builtin firewall rule validation", () => {
  const connectorTypes = connectorTypeSchema.options;

  for (const connectorType of connectorTypes) {
    if (!isFirewallConnectorType(connectorType)) continue;

    it(`${connectorType} — all rules pass validateRule`, () => {
      const firewall = getConnectorFirewall(connectorType);
      for (const api of firewall.apis) {
        for (const perm of api.permissions ?? []) {
          for (const rule of perm.rules) {
            expect(() => {
              return validateRule(rule, perm.name, firewall.name);
            }).not.toThrow();
          }
        }
      }
    });
  }
});
