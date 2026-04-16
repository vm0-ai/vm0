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
 * We group methods by scope (bot and user union) to generate firewall
 * permission groups. Methods with no scope (like auth.test, oauth.*)
 * are included in a "no_scopes_required" group since they still require
 * a valid token.
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

// ── Scope descriptions (from docs.slack.dev/reference/scopes/) ──────────

/**
 * Official Slack scope descriptions sourced from docs.slack.dev.
 * Used to enrich the generated firewall config with human-readable text.
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
  "channels:manage":
    "Manage public channels that the app has been added to and create new ones",
  "conversations.connect:manage":
    "Manage Slack Connect channels (approve or decline invitations)",
  "team.billing:read": "View billing information for a workspace",

  // Read
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
  "bookmarks:write": "Create, edit, and remove bookmarks",
  "calls:write": "Start and manage calls in a workspace",
  "canvases:write": "Create and edit canvases",
  "channels:write":
    "Manage a user's public channels and create new ones on a user's behalf",
  "channels:write.invites": "Invite members to public channels",
  "channels:write.topic": "Set the topic and purpose of public channels",
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
  // Admin (25)
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
  "channels:manage": "Admin",
  "conversations.connect:manage": "Admin",
  "team.billing:read": "Admin",

  // Read (34)
  "bookmarks:read": "Read",
  "calls:read": "Read",
  "canvases:read": "Read",
  "channels:history": "Read",
  "channels:read": "Read",
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

  // Write (23)
  "bookmarks:write": "Write",
  "calls:write": "Write",
  "canvases:write": "Write",
  "channels:write": "Write",
  "channels:write.invites": "Write",
  "channels:write.topic": "Write",
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
  scope?: {
    bot?: string[];
    user?: string[];
  };
  http_method?: string;
}

function loadMethods(): Map<string, SlackMethodData> {
  console.error("Loading slack-api-ref (cached)…");

  const specs = listCachedSpecs("slack");
  const methods = new Map<string, SlackMethodData>();

  for (const { key, content } of specs) {
    // key is "methods/{name}.json"
    const methodName = key.replace(/^methods\//, "").replace(/\.json$/, "");
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      methods.set(methodName, parsed as SlackMethodData);
    }
  }

  console.error(`  ${methods.size} methods`);
  return methods;
}

// ── Grouping ─────────────────────────────────────────────────────────────

function buildGroups(methods: Map<string, SlackMethodData>): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();

  for (const [methodName, data] of methods) {
    const scope = data.scope;
    if (typeof scope !== "object" || scope === null) continue;

    const botScopes = scope.bot ?? [];
    const userScopes = scope.user ?? [];
    const allScopes = new Set([...botScopes, ...userScopes]);

    const httpMethod = data.http_method;
    if (!httpMethod) {
      throw new Error(`Method "${methodName}" missing http_method`);
    }
    const rule = `${httpMethod.toUpperCase()} /${methodName}`;

    if (allScopes.size === 0) {
      let ruleSet = groups.get("no_scopes_required");
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set("no_scopes_required", ruleSet);
      }
      ruleSet.add(rule);
      continue;
    }

    for (const s of allScopes) {
      let ruleSet = groups.get(s);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(s, ruleSet);
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

  return ordered;
}

// ── Default allowed permissions ──────────────────────────────────────────

const DEFAULT_ALLOWED: string[] = [
  "bookmarks:read",
  "channels:history",
  "channels:read",
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
    'import type { FirewallConfig } from "../contracts/firewalls";',
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
