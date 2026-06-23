/**
 * Generate Slack firewall config from Slack API method-to-scope mappings.
 *
 * Data source: slack-ruby/slack-api-ref (community-maintained, auto-synced
 * daily from docs.slack.dev). This is the only available machine-readable
 * source for Slack's method → scope mapping.
 *
 * Repository: https://github.com/slack-ruby/slack-api-ref
 * Path:       docs.slack.dev/methods/*.json
 *
 * Each method JSON file contains:
 *   { "scope": { "bot": ["chat:write"], "user": ["chat:write"] }, ... }
 *
 * We group methods by scope across every token type listed by the source
 * data to generate firewall permission groups. Some Slack methods list
 * multiple alternative scopes for the same runtime endpoint, usually because
 * the required Slack scope depends on conversation type. Those methods use
 * explicit vm0-owned route owners so one runtime route maps to one firewall
 * permission. Methods with no scope (like auth.test, oauth.*) are included in
 * a "no_scopes_required" group since they still require a valid token.
 */

import {
  listCachedSpecs,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

// ── Permission descriptions ──────────────────────────────────────────────

/**
 * Official Slack scope descriptions sourced from docs.slack.dev plus
 * vm0-owned aggregate permission descriptions for shared Slack routes.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  // Admin
  admin:
    "Administer a workspace (access audit logs, SCIM API, and billing info)",
  "admin.analytics:read": "Access workspace analytics data",
  "admin.app_activities:read":
    "View app activities within an Enterprise organization",
  "admin.apps:read": "View apps and app requests in an Enterprise organization",
  "admin.apps:write":
    "Manage apps and app requests in an Enterprise organization",
  "admin.barriers:read":
    "Read information barriers in an Enterprise organization",
  "admin.barriers:write":
    "Manage information barriers in an Enterprise organization",
  "admin.conversations:manage_objects":
    "Manage channel objects in an Enterprise organization",
  "admin.conversations:read":
    "View channels and their settings in an Enterprise organization",
  "admin.conversations:write":
    "Set channel settings in an Enterprise organization",
  "admin.invites:read":
    "View workspace invite requests in an Enterprise organization",
  "admin.invites:write":
    "Manage workspace invite requests in an Enterprise organization",
  "admin.roles:read": "View role assignments in an Enterprise organization",
  "admin.roles:write": "Manage role assignments in an Enterprise organization",
  "admin.teams:read": "View workspace settings in an Enterprise organization",
  "admin.teams:write":
    "Manage workspace settings in an Enterprise organization",
  "admin.usergroups:read": "View user groups in an Enterprise organization",
  "admin.usergroups:write": "Manage user groups in an Enterprise organization",
  "admin.users:read": "View users in an Enterprise organization",
  "admin.users:write": "Manage users in an Enterprise organization",
  "admin.workflows:read":
    "View workflow builder workflows in an Enterprise organization",
  "admin.workflows:write":
    "Manage workflow builder workflows in an Enterprise organization",
  apps: "Manage Slack app collaborators",
  "assistant.search:read": "Search assistant context across Slack content",
  "channels:manage":
    "Manage public channels that the app has been added to and create new ones",
  "conversations:history":
    "View messages and replies across Slack conversation types",
  "conversations:read":
    "View basic information across Slack conversation types",
  "conversations.connect:manage":
    "Manage Slack Connect channels (approve or decline invitations)",
  "conversations.connect:read":
    "View Slack Connect external teams and discoverable contacts",
  "team.billing:read": "View billing information for a workspace",

  // Read
  "app_configurations:read":
    "Read app configuration info via App Manifest APIs",
  "bookmarks:read": "List bookmarks in channels",
  "calls:read": "View information about ongoing and past calls",
  "canvases:read": "Access contents of canvases created inside Slack",
  "channels:history":
    "View messages and other content in public channels that the app has been added to",
  "channels:read":
    "View basic information about public channels in a workspace",
  "datastore:read": "Read data from Slack's hosted datastore",
  "dnd:read": "View Do Not Disturb settings for people in a workspace",
  "emoji:read": "View custom emoji in a workspace",
  "files:read":
    "View files shared in channels and conversations that the app has been added to",
  "groups:history":
    "View messages and other content in private channels that the app has been added to",
  "groups:read":
    "View basic information about private channels that the app has been added to",
  "hosting:read": "Read hosting environment information",
  "identity:read": "View a user's Slack identity (Sign in with Slack)",
  "im:history":
    "View messages and other content in direct messages that the app has been added to",
  "im:read":
    "View basic information about direct messages that the app has access to",
  "lists:read": "View lists in a workspace",
  "mpim:history":
    "View messages and other content in group direct messages that the app has been added to",
  "mpim:read":
    "View basic information about group direct messages that the app has been added to",
  "pins:read":
    "View pinned content in channels and conversations that the app has been added to",
  "reactions:read":
    "View emoji reactions and their associated content in channels and conversations",
  "reminders:read": "View reminders created by the app",
  "remote_files:read": "View remote files added by the app in a workspace",
  "search:read": "Search a workspace's content",
  "search:read.files": "Search for files in a workspace",
  "search:read.im": "Search direct messages",
  "search:read.mpim": "Search group direct messages",
  "search:read.private": "Search private channels",
  "search:read.public": "Search public channels",
  "search:read.users": "Search for users in a workspace",
  "stars:read": "View starred messages and files",
  "team.preferences:read": "View team preferences",
  "team:read":
    "View the name, email domain, and icon for workspaces the app is connected to",
  "triggers:read": "View triggers in a workspace",
  "usergroups:read": "View user groups in a workspace",
  "users.profile:read": "View profile details of people in a workspace",
  "users:read": "View people in a workspace",
  "users:read.email": "View email addresses of people in a workspace",

  // Write
  "app_configurations:write":
    "Write app configuration info and create apps via App Manifest APIs",
  "bookmarks:write": "Create, edit, and remove bookmarks",
  "calls:write": "Start and manage calls in a workspace",
  "canvases:write": "Create and edit canvases",
  "channels:write":
    "Manage a user's public channels and create new ones on a user's behalf",
  "channels:write.invites": "Invite members to public channels",
  "channels:write.topic": "Set the topic and purpose of public channels",
  "conversations:write": "Manage Slack conversations across conversation types",
  "conversations:write.invites":
    "Invite members across Slack conversation types",
  "conversations:write.topic":
    "Set topics and purposes across Slack conversation types",
  "datastore:write": "Write data to Slack's hosted datastore",
  "dnd:write": "Edit a user's Do Not Disturb settings",
  "groups:write":
    "Manage private channels that the user is a member of and create new ones",
  "groups:write.invites": "Invite members to private channels",
  "groups:write.topic": "Set the topic and purpose of private channels",
  "im:write.topic": "Set the topic of direct messages",
  "links:write": "Show previews of URLs in messages",
  "lists:write": "Create and manage lists in a workspace",
  "pins:write": "Add and remove pinned messages and files",
  "reactions:write": "Add and edit emoji reactions",
  "reminders:write": "Add, remove, or complete reminders",
  "remote_files:write": "Add, edit, and delete remote files on a user's behalf",
  "stars:write": "Add or remove stars (saved items)",
  "triggers:write": "Create and manage triggers in a workspace",
  "usergroups:write": "Create and manage user groups",
  "users.profile:write": "Edit a user's profile information and status",
  "users:write": "Set a user's presence status",

  // Send
  "files:write": "Upload, edit, and delete files as the app",
  "assistant:write": "Act as an AI Assistant app",
  "chat:write": "Send messages as the app",
  "conversations.connect:write":
    "Create Slack Connect invitations and accept invitations",
  "im:write": "Start direct messages with people",
  "mpim:write": "Start group direct messages with people",
  "mpim:write.topic": "Set the topic and purpose of group direct messages",
  "remote_files:share": "Share remote files on a user's behalf",

  // Misc
  "channels:join": "Join public channels in a workspace",
  client: "Full access to all client features (legacy, deprecated)",
  openid: "View information about a user's identity (Sign in with Slack)",
  "tokens.basic": "Execute methods with no required scope",
};

// ── Scope categories (from slack.categories.ts, now generated) ──────────

const SCOPE_CATEGORIES: Record<string, string> = {
  // Admin (26)
  admin: "Admin",
  "admin.analytics:read": "Admin",
  "admin.app_activities:read": "Admin",
  "admin.apps:read": "Admin",
  "admin.apps:write": "Admin",
  "admin.barriers:read": "Admin",
  "admin.barriers:write": "Admin",
  "admin.conversations:manage_objects": "Admin",
  "admin.conversations:read": "Admin",
  "admin.conversations:write": "Admin",
  "admin.invites:read": "Admin",
  "admin.invites:write": "Admin",
  "admin.roles:read": "Admin",
  "admin.roles:write": "Admin",
  "admin.teams:read": "Admin",
  "admin.teams:write": "Admin",
  "admin.usergroups:read": "Admin",
  "admin.usergroups:write": "Admin",
  "admin.users:read": "Admin",
  "admin.users:write": "Admin",
  "admin.workflows:read": "Admin",
  "admin.workflows:write": "Admin",
  apps: "Admin",
  "channels:manage": "Admin",
  "conversations.connect:manage": "Admin",
  "team.billing:read": "Admin",

  // Read
  "app_configurations:read": "Read",
  "assistant.search:read": "Read",
  "bookmarks:read": "Read",
  "calls:read": "Read",
  "canvases:read": "Read",
  "channels:history": "Read",
  "channels:read": "Read",
  "conversations:history": "Read",
  "conversations:read": "Read",
  "conversations.connect:read": "Read",
  "datastore:read": "Read",
  "dnd:read": "Read",
  "emoji:read": "Read",
  "files:read": "Read",
  "groups:history": "Read",
  "groups:read": "Read",
  "hosting:read": "Read",
  "identity:read": "Read",
  "im:history": "Read",
  "im:read": "Read",
  "lists:read": "Read",
  "mpim:history": "Read",
  "mpim:read": "Read",
  "pins:read": "Read",
  "reactions:read": "Read",
  "reminders:read": "Read",
  "remote_files:read": "Read",
  "search:read": "Read",
  "search:read.files": "Read",
  "search:read.im": "Read",
  "search:read.mpim": "Read",
  "search:read.private": "Read",
  "search:read.public": "Read",
  "search:read.users": "Read",
  "stars:read": "Read",
  "team.preferences:read": "Read",
  "team:read": "Read",
  "triggers:read": "Read",
  "usergroups:read": "Read",
  "users.profile:read": "Read",
  "users:read": "Read",
  "users:read.email": "Read",

  // Write
  "app_configurations:write": "Write",
  "bookmarks:write": "Write",
  "calls:write": "Write",
  "canvases:write": "Write",
  "channels:write": "Write",
  "channels:write.invites": "Write",
  "channels:write.topic": "Write",
  "conversations:write": "Write",
  "conversations:write.invites": "Write",
  "conversations:write.topic": "Write",
  "datastore:write": "Write",
  "dnd:write": "Write",
  "groups:write": "Write",
  "groups:write.invites": "Write",
  "groups:write.topic": "Write",
  "im:write.topic": "Write",
  "links:write": "Write",
  "lists:write": "Write",
  "pins:write": "Write",
  "reactions:write": "Write",
  "reminders:write": "Write",
  "remote_files:write": "Write",
  "stars:write": "Write",
  "triggers:write": "Write",
  "usergroups:write": "Write",
  "users.profile:write": "Write",
  "users:write": "Write",

  // Send (8)
  "assistant:write": "Send",
  "chat:write": "Send",
  "conversations.connect:write": "Send",
  "files:write": "Send",
  "im:write": "Send",
  "mpim:write": "Send",
  "mpim:write.topic": "Send",
  "remote_files:share": "Send",

  // Misc (5)
  "channels:join": "Misc",
  client: "Misc",
  no_scopes_required: "Misc",
  openid: "Misc",
  "tokens.basic": "Misc",
};

const CATEGORY_ORDER = ["Read", "Write", "Send", "Admin", "Misc"];

// ── Data loading ─────────────────────────────────────────────────────────

interface SlackMethodData {
  scope?: unknown;
  http_method?: unknown;
}

interface SlackMethodOwnerOverride {
  readonly permission: string;
  readonly scopes: readonly string[];
}

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const SLACK_METHOD_OWNER_OVERRIDES = new Map<string, SlackMethodOwnerOverride>([
  [
    "assistant.search.context",
    {
      permission: "assistant.search:read",
      scopes: [
        "search:read.files",
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
        "search:read.users",
      ],
    },
  ],
  [
    "conversations.archive",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.close",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.create",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.history",
    {
      permission: "conversations:history",
      scopes: [
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
      ],
    },
  ],
  [
    "conversations.info",
    {
      permission: "conversations:read",
      scopes: ["channels:read", "groups:read", "im:read", "mpim:read"],
    },
  ],
  [
    "conversations.invite",
    {
      permission: "conversations:write.invites",
      scopes: [
        "channels:manage",
        "channels:write",
        "channels:write.invites",
        "groups:write",
        "groups:write.invites",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.join",
    {
      permission: "channels:join",
      scopes: ["channels:join", "channels:write"],
    },
  ],
  [
    "conversations.kick",
    {
      permission: "conversations:write",
      scopes: ["channels:manage", "channels:write", "groups:write"],
    },
  ],
  [
    "conversations.leave",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.list",
    {
      permission: "conversations:read",
      scopes: ["channels:read", "groups:read", "im:read", "mpim:read"],
    },
  ],
  [
    "conversations.mark",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.members",
    {
      permission: "conversations:read",
      scopes: ["channels:read", "groups:read", "im:read", "mpim:read"],
    },
  ],
  [
    "conversations.open",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.rename",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "conversations.replies",
    {
      permission: "conversations:history",
      scopes: [
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
      ],
    },
  ],
  [
    "conversations.setPurpose",
    {
      permission: "conversations:write.topic",
      scopes: [
        "channels:manage",
        "channels:write",
        "channels:write.topic",
        "groups:write",
        "groups:write.topic",
        "im:write",
        "im:write.topic",
        "mpim:write",
        "mpim:write.topic",
      ],
    },
  ],
  [
    "conversations.setTopic",
    {
      permission: "conversations:write.topic",
      scopes: [
        "channels:manage",
        "channels:write",
        "channels:write.topic",
        "groups:write",
        "groups:write.topic",
        "im:write",
        "im:write.topic",
        "mpim:write",
        "mpim:write.topic",
      ],
    },
  ],
  [
    "conversations.unarchive",
    {
      permission: "conversations:write",
      scopes: [
        "channels:manage",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  ],
  [
    "team.externalTeams.list",
    {
      permission: "conversations.connect:read",
      scopes: ["conversations.connect:manage", "team:read"],
    },
  ],
  [
    "users.conversations",
    {
      permission: "conversations:read",
      scopes: ["channels:read", "groups:read", "im:read", "mpim:read"],
    },
  ],
  [
    "users.discoverableContacts.lookup",
    {
      permission: "conversations.connect:read",
      scopes: ["conversations.connect:manage", "team:read"],
    },
  ],
]);

function loadMethods(): Map<string, SlackMethodData> {
  console.error("Loading slack-api-ref (cached)…");

  const specs = listCachedSpecs("slack");
  const methods = new Map<string, SlackMethodData>();

  for (const { key, content } of specs) {
    // key is "methods/{name}.json"
    const methodName = key.replace(/^methods\//, "").replace(/\.json$/, "");
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Method "${methodName}" spec is not an object`);
    }
    methods.set(methodName, parsed);
  }

  console.error(`  ${methods.size} methods`);
  return methods;
}

// ── Grouping ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectScopes(
  methodName: string,
  scope: Record<string, unknown>,
): Set<string> {
  const allScopes = new Set<string>();

  for (const [tokenType, scopes] of Object.entries(scope)) {
    if (!Array.isArray(scopes)) {
      throw new Error(
        `Method "${methodName}" scope "${tokenType}" is not an array`,
      );
    }

    for (const s of scopes) {
      if (typeof s !== "string") {
        throw new Error(
          `Method "${methodName}" scope "${tokenType}" contains a non-string value`,
        );
      }
      allScopes.add(s);
    }
  }

  return allScopes;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

function formatScopes(scopes: readonly string[]): string {
  return scopes.join(", ");
}

export function pickSlackPermissionOwners(
  methodName: string,
  scopes: readonly string[],
): readonly string[] {
  const uniqueScopes = uniqueSorted(scopes);
  const override = SLACK_METHOD_OWNER_OVERRIDES.get(methodName);
  if (!override) {
    return uniqueScopes;
  }

  const expectedScopes = uniqueSorted(override.scopes);
  const matchesExpected =
    uniqueScopes.length === expectedScopes.length &&
    uniqueScopes.every((scope, index) => {
      return scope === expectedScopes[index];
    });

  if (!matchesExpected) {
    throw new Error(
      `Slack method "${methodName}" owner override scopes changed: expected [${formatScopes(
        expectedScopes,
      )}], got [${formatScopes(uniqueScopes)}]`,
    );
  }

  return [override.permission];
}

function expandRuntimeRule(rule: string): string[] {
  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (method !== "ANY") return [rule];
  return RUNTIME_METHODS.map((runtimeMethod) => {
    return `${runtimeMethod} ${path}`;
  });
}

function assertUniqueSlackRules(permissions: readonly PermissionGroup[]): void {
  const owners = new Map<string, string>();
  const duplicates: string[] = [];

  for (const permission of permissions) {
    for (const rule of permission.rules) {
      for (const runtimeRule of expandRuntimeRule(rule)) {
        const existing = owners.get(runtimeRule);
        if (existing) {
          duplicates.push(`${runtimeRule}: ${existing}, ${permission.name}`);
          continue;
        }
        owners.set(runtimeRule, permission.name);
      }
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      "Slack generated duplicate firewall route owners:\n" +
        duplicates
          .sort((left, right) => {
            return left.localeCompare(right);
          })
          .map((duplicate) => {
            return `  - ${duplicate}`;
          })
          .join("\n"),
    );
  }
}

function buildGroups(methods: Map<string, SlackMethodData>): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();

  for (const [methodName, data] of methods) {
    const scope = data.scope;
    const httpMethod = data.http_method;
    if (typeof httpMethod !== "string" || httpMethod.length === 0) {
      throw new Error(`Method "${methodName}" missing http_method`);
    }
    const rule = `${httpMethod.toUpperCase()} /${methodName}`;

    let allScopes: Set<string>;
    if (scope === "none") {
      allScopes = new Set();
    } else if (isRecord(scope)) {
      allScopes = collectScopes(methodName, scope);
    } else {
      throw new Error(`Method "${methodName}" has invalid scope`);
    }

    if (allScopes.size === 0) {
      let ruleSet = groups.get("no_scopes_required");
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set("no_scopes_required", ruleSet);
      }
      ruleSet.add(rule);
      continue;
    }

    const ownerPermissions = pickSlackPermissionOwners(methodName, [
      ...allScopes,
    ]);
    for (const permissionName of ownerPermissions) {
      let ruleSet = groups.get(permissionName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(permissionName, ruleSet);
      }
      ruleSet.add(rule);
    }
  }

  // Order: regular scopes sorted, then no_scopes_required at the end
  const ordered: PermissionGroup[] = [];
  const sortedKeys = [...groups.keys()]
    .filter((k) => k !== "no_scopes_required")
    .sort();

  for (const name of sortedKeys) {
    const ruleSet = groups.get(name);
    if (ruleSet && ruleSet.size > 0) {
      ordered.push({
        name,
        description: SCOPE_DESCRIPTIONS[name],
        rules: sanitizeAndSortRules([...ruleSet]),
      });
    }
  }

  const noScope = groups.get("no_scopes_required");
  if (noScope && noScope.size > 0) {
    ordered.push({
      name: "no_scopes_required",
      description: "Methods that require a valid token but no specific scope",
      rules: sanitizeAndSortRules([...noScope]),
    });
  }

  assertUniqueSlackRules(ordered);
  return ordered;
}

// ── Default allowed permissions ──────────────────────────────────────────

const DEFAULT_ALLOWED: string[] = [
  "bookmarks:read",
  "conversations.connect:read",
  "conversations:history",
  "conversations:read",
  "emoji:read",
  "pins:read",
  "reactions:read",
  "search:read",
  "team:read",
  "usergroups:read",
  "users.profile:read",
  "users:read",
];

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  // Slack bot token format: xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*
  const placeholder =
    "xoxb-100100100100-1001001001001-CoffeeSafeLocalCoffeeSaf";

  const lines: string[] = [
    "// Auto-generated from Slack API method-to-scope mappings.",
    "// Source: slack-ruby/slack-api-ref (auto-synced daily from docs.slack.dev)",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:slack",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const slackFirewall = {",
    '  name: "slack",',
    '  description: "Slack API",',
    "  placeholders: {",
    `    SLACK_TOKEN: "${placeholder}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://slack.com/api",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");

  // files.slack.com — file downloads use the same token
  lines.push("    {");
  lines.push('      base: "https://files.slack.com",');
  lines.push("      auth: {");
  lines.push("        headers: {");
  lines.push('          Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}",');
  lines.push("        },");
  lines.push("      },");
  lines.push("      permissions: [");
  lines.push("        {");
  lines.push('          name: "files:read",');
  lines.push('          description: "Download files from Slack",');
  lines.push("          rules: [");
  lines.push('            "GET /{path+}",');
  lines.push("          ],");
  lines.push("        },");
  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");

  lines.push(
    ...renderDefaultAllowed(
      "slackDefaultAllowed",
      "slackFirewall",
      DEFAULT_ALLOWED,
    ),
  );

  // Build category map from generated permissions (sorted by permission name)
  const categoryMap: Record<string, string> = {};
  for (const perm of permissions) {
    const cat = SCOPE_CATEGORIES[perm.name];
    if (cat) {
      categoryMap[perm.name] = cat;
    }
  }
  // files:read appears on both apis — ensure it's in the map
  if (!categoryMap["files:read"] && SCOPE_CATEGORIES["files:read"]) {
    categoryMap["files:read"] = SCOPE_CATEGORIES["files:read"];
  }

  lines.push(
    ...renderCategories("slackCategories", "slackFirewall", {
      categories: categoryMap,
      displayOrder: CATEGORY_ORDER,
    }),
  );

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const methods = loadMethods();
  const permissions = buildGroups(methods);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("slack", ts, import.meta.dirname);
}
