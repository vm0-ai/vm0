import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import { isFirewallConnectorType, getConnectorFirewall } from "../firewalls";
import { collectAndValidatePermissions } from "../firewall-expander";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
} from "../firewall-types";

function firewallWithPermissionName(name: string): FirewallConfig {
  return {
    name: "custom",
    apis: [
      {
        base: "https://api.example.com",
        auth: { headers: {} },
        permissions: [
          {
            name,
            rules: ["GET /items"],
          },
        ],
      },
    ],
  };
}

function apiBases(firewall: FirewallConfig): string[] {
  return firewall.apis.map((api) => {
    return api.base;
  });
}

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
  it.each(["all", UNKNOWN_PERMISSION_GRANT])(
    'rejects "%s" as a real permission name',
    (name) => {
      const firewall = firewallWithPermissionName(name);

      expect(() => {
        return collectAndValidatePermissions(firewall);
      }).toThrow(`permission named "${name}"`);
    },
  );
});

describe("known endpoint-scoped firewall bases", () => {
  it("keeps Google Search Console off the shared www.googleapis.com root", () => {
    const bases = apiBases(getConnectorFirewall("google-search-console"));

    expect(bases).toContain("https://searchconsole.googleapis.com");
    expect(bases).not.toContain("https://www.googleapis.com");
  });

  it("narrows Xero tenant discovery to the Connections endpoint", () => {
    const firewall = getConnectorFirewall("xero");
    const bases = apiBases(firewall);
    const connectionsApi = firewall.apis.find((api) => {
      return api.base === "https://api.xero.com/Connections";
    });

    expect(bases).toContain("https://api.xero.com/Connections");
    expect(bases).not.toContain("https://api.xero.com");
    expect(connectionsApi?.permissions).toEqual([
      {
        name: "connections",
        rules: ["GET /", "DELETE /{id}"],
      },
    ]);
  });
});
