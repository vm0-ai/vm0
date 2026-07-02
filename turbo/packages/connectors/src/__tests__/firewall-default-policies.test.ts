import { describe, it, expect } from "vitest";
import { UNKNOWN_PERMISSION_GRANT } from "../firewall-types";
import {
  expandFirewallMetadataDefaultPolicy,
  loadFirewallPermissionMetadata,
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
  type FirewallPermissionDetailMetadata,
} from "../firewall-metadata";

async function loadRequiredFirewallPermissionMetadata(
  type: string,
): Promise<FirewallPermissionDetailMetadata> {
  const metadata = await loadFirewallPermissionMetadata(type);
  if (!metadata) {
    throw new Error(`Missing firewall permission metadata: ${type}`);
  }
  return metadata;
}

async function defaultFirewallPolicies(type: string) {
  return expandFirewallMetadataDefaultPolicy(
    await loadRequiredFirewallPermissionMetadata(type),
  );
}

async function resolveMetadataPolicies(
  stored: Parameters<typeof resolveFirewallMetadataPolicies>[0],
  connectors: readonly string[],
) {
  const metadata = (
    await Promise.all(
      connectors.map((connector) => {
        return loadFirewallPermissionMetadata(connector);
      }),
    )
  ).filter((detail): detail is FirewallPermissionDetailMetadata => {
    return detail !== null;
  });
  return resolveFirewallMetadataPolicies(stored, metadata);
}

describe("getDefaultFirewallPolicies", () => {
  it("should return allow/deny map for connectors with defaults", async () => {
    const policy = await defaultFirewallPolicies("slack");

    // Slack has defaults — every permission should be either "allow" or "deny"
    const values = Object.values(policy.policies);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(["allow", "deny"]).toContain(v);
    }
    expect(policy.unknownPolicy).toBe("allow");
  });

  it("should mark default-allowed permissions as allow", async () => {
    const policy = await defaultFirewallPolicies("slack");
    expect(policy.policies["conversations:read"]).toBe("allow");
  });

  it("should mark non-default permissions as deny", async () => {
    const policy = await defaultFirewallPolicies("slack");
    expect(policy.policies["admin"]).toBe("deny");
  });

  it("should default Gmail read and draft permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("gmail");

    expect(policy.policies["messages.read"]).toBe("allow");
    expect(policy.policies["threads.read"]).toBe("allow");
    expect(policy.policies["settings.read"]).toBe("allow");
    expect(policy.policies["drafts.write"]).toBe("allow");
    expect(policy.policies["messages.send"]).toBe("deny");
    expect(policy.policies["drafts.send"]).toBe("deny");
    expect(policy.policies["messages.write"]).toBe("deny");
    expect(policy.policies["messages.delete"]).toBe("deny");
    expect(policy.policies["settings.sharing"]).toBe("deny");
    expect(policy.policies["notifications.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should cover every permission from the firewall metadata", async () => {
    const policy = await defaultFirewallPolicies("slack");
    const metadata = await loadRequiredFirewallPermissionMetadata("slack");
    const allPermissions = new Set(
      metadata.permissions.map((permission) => {
        return permission.name;
      }),
    );

    for (const name of allPermissions) {
      expect(policy.policies).toHaveProperty(name);
    }
    expect(Object.keys(policy.policies)).toHaveLength(allPermissions.size);
  });

  it("should return empty permissions for connectors with no static permissions", async () => {
    const policy = await defaultFirewallPolicies("github");
    expect(Object.keys(policy.policies)).toHaveLength(0);
    expect(policy.unknownPolicy).toBe("allow");
  });

  it("should default Cloudflare read-only permissions to allow, write permissions to deny, and unknown endpoints to deny", async () => {
    const policy = await defaultFirewallPolicies("cloudflare");

    expect(policy.policies["dns-firewall.read"]).toBe("allow");
    expect(policy.policies["dns-firewall.write"]).toBe("deny");
    expect(policy.policies["account-rulesets.read"]).toBe("allow");
    expect(policy.policies["account-rulesets.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Cloud unknown endpoints to deny", async () => {
    const policy = await defaultFirewallPolicies("google-cloud");

    expect(policy.policies["compute.instances.get"]).toBe("allow");
    expect(policy.policies["compute.instances.create"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Drive read permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-drive");

    expect(policy.policies["apps.read"]).toBe("allow");
    expect(policy.policies["files.read"]).toBe("allow");
    expect(policy.policies["files.write"]).toBe("deny");
    expect(policy.policies["files.delete"]).toBe("deny");
    expect(policy.policies["files.share"]).toBe("deny");
    expect(policy.policies["channels.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Analytics report and read permissions to allow and sensitive mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-analytics");

    expect(policy.policies["reports.run"]).toBe("allow");
    expect(policy.policies["audience-exports.run"]).toBe("allow");
    expect(policy.policies["accounts.read"]).toBe("allow");
    expect(policy.policies["properties.read"]).toBe("allow");
    expect(policy.policies["links.read"]).toBe("allow");
    expect(policy.policies["properties.write"]).toBe("deny");
    expect(policy.policies["properties.delete"]).toBe("deny");
    expect(policy.policies["measurement-secrets.read"]).toBe("deny");
    expect(policy.policies["measurement-secrets.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Calendar read permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-calendar");

    expect(policy.policies["calendars.read"]).toBe("allow");
    expect(policy.policies["events.read"]).toBe("allow");
    expect(policy.policies["calendar-list.read"]).toBe("allow");
    expect(policy.policies["settings.read"]).toBe("allow");
    expect(policy.policies["freebusy.query"]).toBe("allow");
    expect(policy.policies["colors.read"]).toBe("allow");
    expect(policy.policies["acl.read"]).toBe("deny");
    expect(policy.policies["events.write"]).toBe("deny");
    expect(policy.policies["calendar-list.write"]).toBe("deny");
    expect(policy.policies["notifications.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Docs read permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-docs");

    expect(policy.policies["documents.read"]).toBe("allow");
    expect(policy.policies["documents.create"]).toBe("deny");
    expect(policy.policies["documents.write"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Meet read permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-meet");

    expect(policy.policies["spaces.read"]).toBe("allow");
    expect(policy.policies["conference-records.read"]).toBe("allow");
    expect(policy.policies["participants.read"]).toBe("allow");
    expect(policy.policies["participant-sessions.read"]).toBe("allow");
    expect(policy.policies["recordings.read"]).toBe("allow");
    expect(policy.policies["smart-notes.read"]).toBe("allow");
    expect(policy.policies["transcripts.read"]).toBe("allow");
    expect(policy.policies["transcript-entries.read"]).toBe("allow");
    expect(policy.policies["spaces.create"]).toBe("deny");
    expect(policy.policies["spaces.write"]).toBe("deny");
    expect(policy.policies["spaces.end-active-conference"]).toBe("deny");
    expect(policy.policies["workspace-events.subscriptions.read"]).toBe("deny");
    expect(policy.policies["workspace-events.subscriptions.write"]).toBe(
      "deny",
    );
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Sheets read and search permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-sheets");

    expect(policy.policies["spreadsheets.read"]).toBe("allow");
    expect(policy.policies["spreadsheets.read-by-data-filter"]).toBe("allow");
    expect(policy.policies["values.read"]).toBe("allow");
    expect(policy.policies["values.read-by-data-filter"]).toBe("allow");
    expect(policy.policies["developer-metadata.read"]).toBe("allow");
    expect(policy.policies["developer-metadata.search"]).toBe("allow");
    expect(policy.policies["spreadsheets.create"]).toBe("deny");
    expect(policy.policies["spreadsheets.write"]).toBe("deny");
    expect(policy.policies["values.write"]).toBe("deny");
    expect(policy.policies["values.clear"]).toBe("deny");
    expect(policy.policies["sheets.copy"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default Google Search Console read and diagnostic permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("google-search-console");

    expect(policy.policies["url-inspection.inspect"]).toBe("allow");
    expect(policy.policies["mobile-friendly-tests.run"]).toBe("allow");
    expect(policy.policies["search-analytics.query"]).toBe("allow");
    expect(policy.policies["sites.read"]).toBe("allow");
    expect(policy.policies["sitemaps.read"]).toBe("allow");
    expect(policy.policies["sites.write"]).toBe("deny");
    expect(policy.policies["sites.delete"]).toBe("deny");
    expect(policy.policies["sitemaps.write"]).toBe("deny");
    expect(policy.policies["sitemaps.delete"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default YouTube read permissions to allow and mutations to deny", async () => {
    const policy = await defaultFirewallPolicies("youtube");

    expect(policy.policies["videos.read"]).toBe("allow");
    expect(policy.policies["videos.rating.read"]).toBe("allow");
    expect(policy.policies["search.read"]).toBe("allow");
    expect(policy.policies["playlist-items.read"]).toBe("allow");
    expect(policy.policies["comments.read"]).toBe("allow");
    expect(policy.policies["live-chat-messages.read"]).toBe("allow");
    expect(policy.policies["videos.create"]).toBe("deny");
    expect(policy.policies["videos.write"]).toBe("deny");
    expect(policy.policies["videos.delete"]).toBe("deny");
    expect(policy.policies["comments.moderate"]).toBe("deny");
    expect(policy.policies["third-party-links.read"]).toBe("deny");
    expect(policy.policies["tests.create"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("should default maskdb read-only permissions to allow and everything else to deny", async () => {
    const policy = await defaultFirewallPolicies("maskdb");

    expect(policy.policies["db:metadata"]).toBe("allow");
    expect(policy.policies["db:query"]).toBe("allow");
    expect(policy.policies["policy:read"]).toBe("allow");
    expect(policy.policies["db:manage"]).toBe("deny");
    expect(policy.policies["policy:write"]).toBe("deny");
    expect(policy.policies["token:mint"]).toBe("deny");
    expect(policy.policies["token:read"]).toBe("deny");
    expect(policy.policies["token:revoke"]).toBe("deny");
    expect(policy.unknownPolicy).toBe("deny");
  });
});

describe("resolveFirewallPolicies", () => {
  it("should fill in defaults for connectors missing from stored policies", async () => {
    const resolved = await resolveMetadataPolicies(null, ["slack"]);
    expect(resolved).not.toBeNull();
    const slack = resolved!["slack"]!;
    expect(slack).toBeDefined();
    expect(slack.policies["conversations:read"]).toBe("allow");
    expect(slack.policies["admin"]).toBe("deny");
  });

  it("should merge defaults with stored policies (stored overrides)", async () => {
    const stored = {
      slack: { policies: { "conversations:read": "deny" as const } },
    };
    const resolved = await resolveMetadataPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.policies["conversations:read"]).toBe("deny");
    expect(slack.policies["admin"]).toBe("deny");
    expect(slack.policies["users:read"]).toBe("allow");
  });

  it("should merge stored partial policy with defaults", async () => {
    const stored = {
      slack: { policies: { "files:read": "allow" as const } },
    };
    const resolved = await resolveMetadataPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.policies["files:read"]).toBe("allow");
    expect(slack.policies["conversations:read"]).toBe("allow");
    expect(slack.policies["conversations:history"]).toBe("allow");
    expect(slack.policies["users:read"]).toBe("allow");
    expect(slack.policies["admin"]).toBe("deny");
  });

  it("should preserve stored unknownPolicy override", async () => {
    const stored = {
      slack: { policies: {}, unknownPolicy: "deny" as const },
    };
    const resolved = await resolveMetadataPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.unknownPolicy).toBe("deny");
  });

  it("should default unknownPolicy to allow when not stored", async () => {
    const stored = {
      slack: { policies: { "conversations:read": "allow" as const } },
    };
    const resolved = await resolveMetadataPolicies(stored, ["slack"]);
    expect(resolved!["slack"]!.unknownPolicy).toBe("allow");
  });

  it("should use connector-specific unknownPolicy defaults when not stored", async () => {
    const resolved = await resolveMetadataPolicies(null, [
      "cloudflare",
      "google-analytics",
      "google-calendar",
      "google-cloud",
      "google-docs",
      "google-meet",
      "google-search-console",
      "google-sheets",
      "gmail",
    ]);
    expect(resolved!["cloudflare"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-analytics"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-calendar"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-cloud"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-docs"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-meet"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-search-console"]!.unknownPolicy).toBe("deny");
    expect(resolved!["google-sheets"]!.unknownPolicy).toBe("deny");
    expect(resolved!["gmail"]!.unknownPolicy).toBe("deny");
  });

  it("should preserve stored unknownPolicy override over connector-specific defaults", async () => {
    const stored = {
      cloudflare: { policies: {}, unknownPolicy: "allow" as const },
    };
    const resolved = await resolveMetadataPolicies(stored, ["cloudflare"]);
    expect(resolved!["cloudflare"]!.unknownPolicy).toBe("allow");
  });

  it("should preserve stored overrides for connectors without default-allowed list", async () => {
    const stored = {
      github: { policies: { "repo-read": "deny" as const } },
    };
    const resolved = await resolveMetadataPolicies(stored, ["github"]);
    expect(resolved!["github"]!.policies["repo-read"]).toBe("deny");
  });

  it("should skip non-firewall connector types", async () => {
    const resolved = await resolveMetadataPolicies(null, ["cloudinary"]);
    expect(resolved).toBeNull();
  });

  it("should handle mixed connectors", async () => {
    const stored = {
      github: { policies: { "repo-read": "allow" as const } },
    };
    const resolved = await resolveMetadataPolicies(stored, [
      "github",
      "slack",
      "cloudinary",
    ]);
    expect(resolved!["github"]!.policies["repo-read"]).toBe("allow");
    expect(resolved!["slack"]).toBeDefined();
    expect(resolved!["slack"]!.policies["conversations:read"]).toBe("allow");
    expect(resolved).not.toHaveProperty("cloudinary");
  });

  it("should produce entry for connectors with no stored policies", async () => {
    const resolved = await resolveMetadataPolicies(null, ["github"]);
    expect(resolved).not.toBeNull();
    expect(resolved!["github"]!.policies).toEqual({});
    expect(resolved!["github"]!.unknownPolicy).toBe("allow");
  });
});

describe("permissionGrantsToFirewallPolicies", () => {
  it("should return null for empty grant rows", () => {
    expect(permissionGrantsToFirewallPolicies([])).toBeNull();
  });

  it("should fold permission grant rows into firewall policies", () => {
    expect(
      permissionGrantsToFirewallPolicies([
        {
          connectorRef: "slack",
          permission: "chat:write",
          action: "allow",
        },
        {
          connectorRef: "slack",
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "deny",
        },
      ]),
    ).toStrictEqual({
      slack: {
        policies: { "chat:write": "allow" },
        unknownPolicy: "deny",
      },
    });
  });

  it("should leave connector defaults to resolveFirewallPolicies", async () => {
    const resolved = await resolveMetadataPolicies(
      permissionGrantsToFirewallPolicies([
        {
          connectorRef: "slack",
          permission: "chat:write",
          action: "allow",
        },
      ]),
      ["slack"],
    );

    expect(resolved!["slack"]!.policies["conversations:read"]).toBe("allow");
    expect(resolved!["slack"]!.policies["admin"]).toBe("deny");
    expect(resolved!["slack"]!.policies["chat:write"]).toBe("allow");
  });
});
