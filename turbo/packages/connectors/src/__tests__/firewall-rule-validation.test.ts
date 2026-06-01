import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import { isFirewallConnectorType, getConnectorFirewall } from "../firewalls";
import { collectAndValidatePermissions } from "../firewall-expander";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
} from "../firewall-types";

/**
 * Validate that every builtin connector firewall passes the same full
 * validation pipeline as custom (user-supplied) firewalls: base URLs,
 * permission structure (non-empty, no reserved names, no duplicates),
 * and rule paths.
 *
 * This catches issues like query strings / fragments in rule paths,
 * malformed base URL patterns, or duplicate permission names sneaking
 * in via OpenAPI specs during code generation.
 */
describe("builtin firewall validation", () => {
  const connectorTypes = connectorTypeSchema.options;

  for (const connectorType of connectorTypes) {
    if (!isFirewallConnectorType(connectorType)) continue;

    it(`${connectorType} — passes full firewall validation`, () => {
      const firewall = getConnectorFirewall(connectorType);
      expect(() => {
        return collectAndValidatePermissions(firewall);
      }).not.toThrow();
    });
  }
});

describe("reserved firewall permission names", () => {
  it("rejects the unknown permission grant sentinel as a real permission", () => {
    const firewall: FirewallConfig = {
      name: "custom",
      apis: [
        {
          base: "https://api.example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: UNKNOWN_PERMISSION_GRANT,
              rules: ["GET /items"],
            },
          ],
        },
      ],
    };

    expect(() => {
      return collectAndValidatePermissions(firewall);
    }).toThrow(`permission named "${UNKNOWN_PERMISSION_GRANT}"`);
  });
});
