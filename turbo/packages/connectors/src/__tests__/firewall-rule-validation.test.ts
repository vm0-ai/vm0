import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import { isFirewallConnectorType, getConnectorFirewall } from "../firewalls";
import { collectAndValidatePermissions } from "../firewall-expander";
import { matchFirewallBaseUrl } from "../firewall-rule-matcher";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
} from "../firewall-types";

interface FirewallBaseEntry {
  readonly connectorType: string;
  readonly apiIndex: number;
  readonly base: string;
  readonly sampleUrls: readonly string[];
}

const FIREWALL_BASE_SAMPLE_VALUES = ["api", "foo", "bar", "v1", "me", "123"];
const ALLOWED_FIREWALL_BASE_OVERLAPS = new Set([
  // `{network}` currently also matches `api`; avoid adding more Alchemy overlaps.
  "alchemy[0] https://{network}.g.alchemy.com <-> alchemy[1] https://api.g.alchemy.com",
  // Meta and Instagram share the Facebook Graph API origin.
  "instagram[1] https://graph.facebook.com <-> meta-ads[0] https://graph.facebook.com",
  "instagram[1] https://graph.facebook.com <-> meta-ads[1] https://graph.facebook.com",
  // Meta Ads has a same-origin page-token exception that intentionally skips auth injection.
  "meta-ads[0] https://graph.facebook.com <-> meta-ads[1] https://graph.facebook.com",
  // Outlook Mail and Calendar both use Microsoft Graph.
  "outlook-calendar[0] https://graph.microsoft.com <-> outlook-mail[0] https://graph.microsoft.com",
  // Railway account/workspace and project tokens hit the same public API origin.
  "railway[0] https://backboard.railway.com <-> railway-project[0] https://backboard.railway.com",
]);

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

function baseSampleUrls(base: string): string[] {
  if (base.includes("${{")) return [];
  return FIREWALL_BASE_SAMPLE_VALUES.map((value) => {
    return base.replace(/\{[^}]+\}/g, value);
  });
}

function firewallBaseLabel(entry: FirewallBaseEntry): string {
  return `${entry.connectorType}[${entry.apiIndex}] ${entry.base}`;
}

function collectBuiltinFirewallBaseEntries(): FirewallBaseEntry[] {
  const entries: FirewallBaseEntry[] = [];
  for (const connectorType of connectorTypeSchema.options) {
    if (!isFirewallConnectorType(connectorType)) continue;
    const firewall = getConnectorFirewall(connectorType);
    firewall.apis.forEach((api, apiIndex) => {
      const sampleUrls = baseSampleUrls(api.base);
      if (sampleUrls.length === 0) return;
      entries.push({
        connectorType,
        apiIndex,
        base: api.base,
        sampleUrls,
      });
    });
  }
  return entries;
}

function findBuiltinFirewallBaseOverlaps(): string[] {
  const entries = collectBuiltinFirewallBaseEntries();
  const overlaps = new Set<string>();
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex += 1
    ) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      const leftMatchesRight = left.sampleUrls.some((sampleUrl) => {
        return matchFirewallBaseUrl(sampleUrl, right.base) !== null;
      });
      const rightMatchesLeft = right.sampleUrls.some((sampleUrl) => {
        return matchFirewallBaseUrl(sampleUrl, left.base) !== null;
      });
      if (leftMatchesRight || rightMatchesLeft) {
        overlaps.add(
          `${firewallBaseLabel(left)} <-> ${firewallBaseLabel(right)}`,
        );
      }
    }
  }
  return [...overlaps].sort();
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

describe("builtin firewall base overlap guard", () => {
  it("does not introduce new builtin base overlaps", () => {
    const overlaps = findBuiltinFirewallBaseOverlaps();
    const unexpectedOverlaps = overlaps.filter((overlap) => {
      return !ALLOWED_FIREWALL_BASE_OVERLAPS.has(overlap);
    });
    const staleAllowedOverlaps = [...ALLOWED_FIREWALL_BASE_OVERLAPS].filter(
      (overlap) => {
        return !overlaps.includes(overlap);
      },
    );

    expect(
      unexpectedOverlaps,
      "New firewall base overlaps can make auth injection ambiguous. Narrow the new base, or add a justified allowlist entry only for an unavoidable shared API surface.",
    ).toEqual([]);
    expect(
      staleAllowedOverlaps,
      "Remove fixed firewall base overlaps from ALLOWED_FIREWALL_BASE_OVERLAPS.",
    ).toEqual([]);
  });
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
