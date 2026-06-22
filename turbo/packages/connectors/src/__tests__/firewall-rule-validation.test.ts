import { describe, it, expect } from "vitest";
import { connectorTypeSchema } from "../connectors";
import {
  BILLABLE_CONNECTORS,
  isFirewallConnectorType,
  getConnectorFirewall,
} from "../firewalls";
import { collectAndValidatePermissions } from "../firewall-expander";
import {
  matchFirewallHost,
  matchFirewallBaseUrl,
} from "../firewall-rule-matcher";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
} from "../firewall-types";

interface FirewallBaseEntry {
  readonly connectorType: string;
  readonly apiIndex: number;
  readonly base: string;
  readonly protocol: string;
  readonly authorityPattern: string;
  readonly sampleUrls: readonly string[];
  readonly sampleAuthorities: readonly string[];
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
  // Microsoft 365, Outlook Mail, and Outlook Calendar share Microsoft Graph.
  "microsoft-365[0] https://graph.microsoft.com <-> outlook-calendar[0] https://graph.microsoft.com",
  "microsoft-365[0] https://graph.microsoft.com <-> outlook-mail[0] https://graph.microsoft.com",
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

function baseProtocolAndAuthority(
  base: string,
): { protocol: string; authority: string } | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(base);
  if (!match) return null;
  return {
    protocol: match[1]!.toLowerCase(),
    authority: match[2]!,
  };
}

function sampleAuthority(sampleUrl: string): string | null {
  try {
    return new URL(sampleUrl).host;
  } catch {
    return null;
  }
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
      const parsedBase = baseProtocolAndAuthority(api.base);
      if (sampleUrls.length === 0) return;
      if (parsedBase === null) return;
      entries.push({
        connectorType,
        apiIndex,
        base: api.base,
        protocol: parsedBase.protocol,
        authorityPattern: parsedBase.authority,
        sampleUrls,
        sampleAuthorities: sampleUrls
          .map(sampleAuthority)
          .filter((authority): authority is string => {
            return authority !== null;
          }),
      });
    });
  }
  return entries;
}

function sampleAuthorityMatchesPattern(
  authority: string,
  pattern: string,
): boolean {
  return matchFirewallHost(authority, pattern) !== null;
}

function entriesMayShareAuthority(
  left: FirewallBaseEntry,
  right: FirewallBaseEntry,
): boolean {
  if (left.protocol !== right.protocol) return false;
  return (
    left.sampleAuthorities.some((authority) => {
      return sampleAuthorityMatchesPattern(authority, right.authorityPattern);
    }) ||
    right.sampleAuthorities.some((authority) => {
      return sampleAuthorityMatchesPattern(authority, left.authorityPattern);
    })
  );
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
      if (!entriesMayShareAuthority(left, right)) continue;
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

describe("billable connector firewall contracts", () => {
  it("keeps X registered as a billable firewall", () => {
    const firewall = getConnectorFirewall("x");

    expect(firewall.name).toBe("x");
    expect(BILLABLE_CONNECTORS).toContain("x");
  });
});

describe("Google Drive firewall permissions", () => {
  it("uses vm0 permission names instead of Google OAuth scope names", () => {
    const firewall = getConnectorFirewall("google-drive");
    const names = firewall.apis.flatMap((api) => {
      return (
        api.permissions?.map((permission) => {
          return permission.name;
        }) ?? []
      );
    });

    expect(names).toContain("apps.read");
    expect(names).toContain("files.write");
    expect(names).not.toContain("drive.apps.readonly");
    expect(names).not.toContain("drive.file");
    expect(
      names.every((name) => {
        return !name.startsWith("drive.");
      }),
    ).toBe(true);
  });

  it("keeps apps.read limited to Drive app routes", () => {
    const firewall = getConnectorFirewall("google-drive");
    const appsReadRules = firewall.apis.flatMap((api) => {
      return (
        api.permissions
          ?.filter((permission) => {
            return permission.name === "apps.read";
          })
          .flatMap((permission) => {
            return permission.rules;
          }) ?? []
      );
    });

    expect(appsReadRules).toStrictEqual([
      "GET /v2/apps",
      "GET /v2/apps/{appId}",
      "GET /v3/apps",
      "GET /v3/apps/{appId}",
    ]);
    expect(appsReadRules).not.toContain("POST /v2/files");
  });
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
  }, 10_000);
});

describe("known endpoint-scoped firewall bases", () => {
  it("keeps Gmail permission names resource-oriented instead of OAuth-scope based", () => {
    const names = new Set(
      getConnectorFirewall("gmail").apis.flatMap((api) => {
        return (
          api.permissions?.map((permission) => {
            return permission.name;
          }) ?? []
        );
      }),
    );

    expect(names).toContain("messages.send");
    expect(names).toContain("drafts.write");
    expect(names).toContain("settings.sharing");
    expect(names).not.toContain("gmail.send");
    expect(names).not.toContain("gmail.modify");
    expect(
      [...names].filter((name) => {
        return name.startsWith("gmail.");
      }),
    ).toEqual([]);
  });

  it("keeps Gmail send routes out of draft write permission", () => {
    const firewall = getConnectorFirewall("gmail");
    const rulesByPermission = new Map<string, Set<string>>();

    for (const api of firewall.apis) {
      for (const permission of api.permissions ?? []) {
        const rules = rulesByPermission.get(permission.name) ?? new Set();
        for (const rule of permission.rules) {
          rules.add(`${api.base} ${rule}`);
        }
        rulesByPermission.set(permission.name, rules);
      }
    }

    expect([...rulesByPermission.get("messages.send")!].sort()).toEqual([
      "https://gmail.googleapis.com/gmail POST /v1/users/{userId}/messages/send",
      "https://gmail.googleapis.com/resumable/upload/gmail POST /v1/users/{userId}/messages/send",
      "https://gmail.googleapis.com/upload/gmail POST /v1/users/{userId}/messages/send",
    ]);
    expect(rulesByPermission.get("drafts.write")).not.toContain(
      "https://gmail.googleapis.com/gmail POST /v1/users/{userId}/drafts/send",
    );
  });

  it("keeps Google Search Console off the shared www.googleapis.com root", () => {
    const bases = apiBases(getConnectorFirewall("google-search-console"));

    expect(bases).toContain("https://searchconsole.googleapis.com");
    expect(bases).not.toContain("https://www.googleapis.com");
  });

  it("keeps Google Sheets permission names resource-oriented instead of OAuth-scope based", () => {
    const names = new Set(
      getConnectorFirewall("google-sheets").apis.flatMap((api) => {
        return (
          api.permissions?.map((permission) => {
            return permission.name;
          }) ?? []
        );
      }),
    );

    expect(names).toContain("spreadsheets.read");
    expect(names).toContain("values.write");
    expect(names).toContain("developer-metadata.search");
    expect(names).not.toContain("drive");
    expect(names).not.toContain("drive.file");
    expect(names).not.toContain("drive.readonly");
    expect(names).not.toContain("spreadsheets");
    expect(names).not.toContain("spreadsheets.readonly");
  });

  it("keeps Google Sheets value read routes out of write and clear permissions", () => {
    const firewall = getConnectorFirewall("google-sheets");
    const rulesByPermission = new Map<string, Set<string>>();

    for (const api of firewall.apis) {
      for (const permission of api.permissions ?? []) {
        const rules = rulesByPermission.get(permission.name) ?? new Set();
        for (const rule of permission.rules) {
          rules.add(`${api.base} ${rule}`);
        }
        rulesByPermission.set(permission.name, rules);
      }
    }

    expect([...rulesByPermission.get("values.read")!].sort()).toEqual([
      "https://sheets.googleapis.com GET /v4/spreadsheets/{spreadsheetId}/values/{range}",
      "https://sheets.googleapis.com GET /v4/spreadsheets/{spreadsheetId}/values:batchGet",
    ]);
    expect(rulesByPermission.get("values.write")).not.toContain(
      "https://sheets.googleapis.com GET /v4/spreadsheets/{spreadsheetId}/values/{range}",
    );
    expect(rulesByPermission.get("values.clear")).not.toContain(
      "https://sheets.googleapis.com GET /v4/spreadsheets/{spreadsheetId}/values:batchGet",
    );
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
