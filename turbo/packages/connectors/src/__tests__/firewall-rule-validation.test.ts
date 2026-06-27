import { describe, it, expect } from "vitest";
import { collectAndValidatePermissions } from "../firewall-expander";
import { getFirewallExecutionMetadata } from "../firewall-metadata/server";
import {
  matchFirewallHost,
  matchFirewallBaseUrl,
} from "../firewall-rule-matcher";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
} from "../firewall-types";
import {
  loadRequiredConnectorFirewall,
  loadRuntimeFirewallEntries,
} from "./firewall-test-helpers";

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
const FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS = 60_000;
const ALLOWED_FIREWALL_BASE_OVERLAPS = new Set([
  // `{network}` currently also matches `api`; avoid adding more Alchemy overlaps.
  "alchemy[0] https://{network}.g.alchemy.com <-> alchemy[1] https://api.g.alchemy.com",
  // Cloudflare intentionally has one connector-auth API and one authless upload API on the same base;
  // cloudflare.test.ts checks their request-level route sets stay disjoint.
  "cloudflare[0] https://api.cloudflare.com/client <-> cloudflare[1] https://api.cloudflare.com/client",
  // Meta and Instagram share the Facebook Graph API origin.
  "instagram[1] https://graph.facebook.com <-> meta-ads[0] https://graph.facebook.com",
  "instagram[1] https://graph.facebook.com <-> meta-ads[1] https://graph.facebook.com",
  // Meta Ads has a same-origin page-token exception that intentionally skips auth injection.
  "meta-ads[0] https://graph.facebook.com <-> meta-ads[1] https://graph.facebook.com",
  // Cloudflare keeps provider-issued upload JWTs on a narrow second API entry.
  "cloudflare[0] https://api.cloudflare.com/client <-> cloudflare[1] https://api.cloudflare.com/client",
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

function collectBuiltinFirewallBaseEntries(
  firewalls: readonly (readonly [string, FirewallConfig])[],
): FirewallBaseEntry[] {
  const entries: FirewallBaseEntry[] = [];
  for (const [connectorType, firewall] of firewalls) {
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

function findBuiltinFirewallBaseOverlaps(
  firewalls: readonly (readonly [string, FirewallConfig])[],
): string[] {
  const entries = collectBuiltinFirewallBaseEntries(firewalls);
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
  it(
    "passes full firewall validation for every runtime connector",
    async () => {
      for (const [
        connectorType,
        firewall,
      ] of await loadRuntimeFirewallEntries()) {
        expect(() => {
          return collectAndValidatePermissions(firewall);
        }, connectorType).not.toThrow();
      }
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );
});

describe("billable connector firewall contracts", () => {
  it("keeps X registered as a billable firewall", async () => {
    const firewall = await loadRequiredConnectorFirewall("x");

    expect(firewall.name).toBe("x");
    expect(getFirewallExecutionMetadata("x")?.billable).toBe(true);
  });
});

describe("Google Drive firewall permissions", () => {
  it("uses vm0 permission names instead of Google OAuth scope names", async () => {
    const firewall = await loadRequiredConnectorFirewall("google-drive");
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

  it("keeps apps.read limited to Drive app routes", async () => {
    const firewall = await loadRequiredConnectorFirewall("google-drive");
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
  it(
    "does not introduce new builtin base overlaps",
    async () => {
      const overlaps = findBuiltinFirewallBaseOverlaps(
        await loadRuntimeFirewallEntries(),
      );
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
    },
    FULL_FIREWALL_SOURCE_TEST_TIMEOUT_MS,
  );
});

describe("known endpoint-scoped firewall bases", () => {
  it("keeps Gmail permission names resource-oriented instead of OAuth-scope based", async () => {
    const firewall = await loadRequiredConnectorFirewall("gmail");
    const names = new Set(
      firewall.apis.flatMap((api) => {
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

  it("keeps Gmail send routes out of draft write permission", async () => {
    const firewall = await loadRequiredConnectorFirewall("gmail");
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

  it("keeps Dropbox custom quota mutations out of members read permission", async () => {
    const firewall = await loadRequiredConnectorFirewall("dropbox");
    const rulesByPermission = new Map<string, Set<string>>();
    const getCustomQuotaRule =
      "https://api.dropboxapi.com POST /2/team/member_space_limits/get_custom_quota";
    const setCustomQuotaRule =
      "https://api.dropboxapi.com POST /2/team/member_space_limits/set_custom_quota";

    for (const api of firewall.apis) {
      for (const permission of api.permissions ?? []) {
        const rules = rulesByPermission.get(permission.name) ?? new Set();
        for (const rule of permission.rules) {
          rules.add(`${api.base} ${rule}`);
        }
        rulesByPermission.set(permission.name, rules);
      }
    }

    expect(rulesByPermission.get("members.read")).toContain(getCustomQuotaRule);
    expect(rulesByPermission.get("members.read")).not.toContain(
      setCustomQuotaRule,
    );
    expect(rulesByPermission.get("members.write")).toContain(
      setCustomQuotaRule,
    );
  });

  it("keeps Google Search Console off the shared www.googleapis.com root", async () => {
    const bases = apiBases(
      await loadRequiredConnectorFirewall("google-search-console"),
    );

    expect(bases).toContain("https://searchconsole.googleapis.com");
    expect(bases).not.toContain("https://www.googleapis.com");
  });

  it("keeps Google Sheets permission names resource-oriented instead of OAuth-scope based", async () => {
    const firewall = await loadRequiredConnectorFirewall("google-sheets");
    const names = new Set(
      firewall.apis.flatMap((api) => {
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

  it("keeps Google Sheets value read routes out of write and clear permissions", async () => {
    const firewall = await loadRequiredConnectorFirewall("google-sheets");
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

  it("keeps Google Search Console permission names resource-oriented instead of OAuth-scope based", async () => {
    const firewall = await loadRequiredConnectorFirewall(
      "google-search-console",
    );
    const names = new Set(
      firewall.apis.flatMap((api) => {
        return (
          api.permissions?.map((permission) => {
            return permission.name;
          }) ?? []
        );
      }),
    );

    expect(names).toContain("sites.read");
    expect(names).toContain("sitemaps.write");
    expect(names).toContain("url-inspection.inspect");
    expect(names).not.toContain("webmasters");
    expect(names).not.toContain("webmasters.readonly");
    expect(
      [...names].filter((name) => {
        return name.startsWith("webmasters");
      }),
    ).toEqual([]);
  });

  it("keeps YouTube permission names resource-oriented instead of OAuth-scope based", async () => {
    const firewall = await loadRequiredConnectorFirewall("youtube");
    const names = new Set(
      firewall.apis.flatMap((api) => {
        return (
          api.permissions?.map((permission) => {
            return permission.name;
          }) ?? []
        );
      }),
    );

    expect(names).toContain("videos.read");
    expect(names).toContain("comments.moderate");
    expect(names).toContain("third-party-links.read");
    expect(names).not.toContain("youtube");
    expect(names).not.toContain("youtube.force-ssl");
    expect(names).not.toContain("youtube.readonly");
    expect(names).not.toContain("youtube.upload");
    expect(
      [...names].filter((name) => {
        return name.startsWith("youtube.");
      }),
    ).toEqual([]);
  });

  it("keeps YouTube upload routes attached to upload-specific permissions", async () => {
    const firewall = await loadRequiredConnectorFirewall("youtube");
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

    expect([...rulesByPermission.get("videos.create")!].sort()).toEqual([
      "https://youtube.googleapis.com/resumable/upload/youtube POST /v3/videos",
      "https://youtube.googleapis.com/upload/youtube POST /v3/videos",
      "https://youtube.googleapis.com/youtube POST /v3/videos",
    ]);
    expect(rulesByPermission.get("videos.write")).not.toContain(
      "https://youtube.googleapis.com/upload/youtube POST /v3/videos",
    );
    expect(rulesByPermission.get("videos.read")).not.toContain(
      "https://youtube.googleapis.com/youtube POST /v3/videos",
    );
  });

  it("narrows Xero tenant discovery to the Connections endpoint", async () => {
    const firewall = await loadRequiredConnectorFirewall("xero");
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
