/**
 * Generate Cloudflare firewall config from Cloudflare's official OpenAPI spec
 * and OAuth scopes list.
 *
 * Data source:
 * - https://github.com/cloudflare/api-schemas
 * - https://api.cloudflare.com/client/v4/oauth/scopes
 *
 * Cloudflare publishes operation-level `x-api-token-group` metadata in the
 * OpenAPI schema. The groups are the official API token permission groups.
 * When Cloudflare lists multiple groups for one operation, the firewall selects
 * one owning permission from official operation metadata before selecting the
 * operation action. This keeps each route in a single permission while avoiding
 * blanket inference from HTTP method alone: Cloudflare has GET endpoints that
 * require write-capable groups, such as token retrieval endpoints.
 *
 * Cloudflare's /oauth/scopes endpoint publishes the official OAuth scope
 * category used for grouping permissions in the UI. It requires authentication,
 * so update-specs must cache it before this generator runs.
 *
 * Token format (gitleaks: cloudflare-api-key): [A-Za-z0-9_-]{40}
 */

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  fetchSpec,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { OpenApiSpec, PermissionGroup } from "./codegen";
import {
  CLOUDFLARE_OAUTH_SCOPES_URL,
  CLOUDFLARE_OPENAPI_URL,
} from "./cloudflare-sources";

// Format: [A-Za-z0-9_-]{40} (gitleaks: cloudflare-api-key)
const PLACEHOLDER_VALUE = "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafe";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client";
const CLOUDFLARE_API_VERSION_PREFIX = "/v4";

type PermissionAction =
  | "admin"
  | "bind"
  | "edit"
  | "evaluate"
  | "index"
  | "location"
  | "monitoring"
  | "purge"
  | "read"
  | "realtime"
  | "report"
  | "revoke"
  | "run"
  | "send"
  | "shield"
  | "write";

interface NormalizedPermission {
  name: string;
  action: PermissionAction;
  ownerKey: string;
  sourceGroup: string;
  sourceStem: string;
  description: string;
}

interface OperationContext {
  apiPath: string;
  method: string;
  tags: string[];
  operationId: string | null;
  summary: string | null;
  description: string | null;
  cfPermissionsRequired: string[];
}

interface OAuthCategoryData {
  categoriesByPermission: Map<string, string>;
  displayOrder: string[];
}

interface BuildStats {
  totalOperations: number;
  operationsWithApiTokenGroup: number;
  operationsWithCfPermissionsRequired: number;
  mappedOperations: number;
  unmappedOperations: number;
  ambiguousOperations: number;
  multiGroupOperations: number;
  operationsWithPrioritizedOwners: number;
  groupsDroppedByOwnerPriority: number;
  operationsWithUnscoredOwnerSelection: number;
  operationsWithPrioritizedReadGroups: number;
  readGroupsDroppedByPriority: number;
  permissionCount: number;
}

interface BuildResult {
  permissions: PermissionGroup[];
  categories: Record<string, string>;
  categoryOrder: string[];
  defaultAllowed: string[];
  stats: BuildStats;
}

const ACTION_SUFFIXES: ReadonlyArray<{
  suffix: string;
  action: PermissionAction;
}> = [
  { suffix: " Monitoring", action: "monitoring" },
  { suffix: " Evaluate", action: "evaluate" },
  { suffix: " Location", action: "location" },
  { suffix: " Realtime", action: "realtime" },
  { suffix: " Revoke", action: "revoke" },
  { suffix: " Report", action: "report" },
  { suffix: " Write", action: "write" },
  { suffix: " Admin", action: "admin" },
  { suffix: " Purge", action: "purge" },
  { suffix: " Index", action: "index" },
  { suffix: " Read", action: "read" },
  { suffix: " Edit", action: "write" },
  { suffix: " Bind", action: "bind" },
  { suffix: " Send", action: "send" },
  { suffix: " Run", action: "run" },
];

const ACTION_PRIORITY: Record<PermissionAction, number> = {
  admin: 70,
  bind: 40,
  edit: 60,
  evaluate: 40,
  index: 40,
  location: 40,
  monitoring: 40,
  purge: 50,
  read: 0,
  realtime: 40,
  report: 40,
  revoke: 50,
  run: 40,
  send: 40,
  shield: 40,
  write: 60,
};

const ACTION_TEXT_TOKENS: Readonly<
  Record<PermissionAction, readonly string[]>
> = {
  admin: ["admin"],
  bind: ["bind", "binding"],
  edit: ["edit", "update"],
  evaluate: ["evaluate", "evaluation"],
  index: ["index"],
  location: ["location"],
  monitoring: ["monitoring", "monitor"],
  purge: ["purge"],
  read: [],
  realtime: ["realtime"],
  report: ["report"],
  revoke: ["revoke"],
  run: ["run"],
  send: ["send"],
  shield: ["shield"],
  write: ["write", "create", "update", "delete"],
};

const READ_OPERATION_METHODS = new Set(["get", "head", "options"]);

const READ_OPERATION_TOKENS = new Set([
  "check",
  "details",
  "download",
  "fetch",
  "get",
  "list",
  "preview",
  "query",
  "read",
  "retrieve",
  "search",
  "validate",
  "view",
]);

const WRITE_OPERATION_TOKENS = new Set([
  "add",
  "apply",
  "create",
  "delete",
  "edit",
  "patch",
  "purge",
  "refresh",
  "remove",
  "replace",
  "revoke",
  "rotate",
  "send",
  "start",
  "stop",
  "update",
  "upload",
  "write",
]);

const TOKEN_ALIASES = new Map<string, string>([
  ["apps", "app"],
  ["application", "app"],
  ["applications", "app"],
  ["certificates", "certificate"],
  ["configs", "config"],
  ["configurations", "configuration"],
  ["datasets", "dataset"],
  ["policies", "policy"],
  ["prefixes", "prefix"],
  ["redirects", "redirect"],
  ["rulesets", "ruleset"],
  ["scripts", "script"],
  ["settings", "setting"],
  ["tokens", "token"],
]);

const WEAK_OWNER_TOKENS = new Set([
  "a",
  "account",
  "accounts",
  "an",
  "and",
  "api",
  "cloudflare",
  "for",
  "one",
  "read",
  "the",
  "write",
  "zone",
  "zones",
]);

const TAG_OWNER_OVERRIDES = new Map<string, string>([
  ["accounts", "account-settings"],
  ["zone-rulesets", "zone-waf"],
]);

const PATH_OWNER_OVERRIDES: ReadonlyArray<{
  prefix: string;
  ownerKey: string;
}> = [
  { prefix: "/accounts/{account_id}/cni/", ownerKey: "magic-wan" },
  {
    prefix: "/accounts/{account_id}/iam/permission_groups",
    ownerKey: "account-settings",
  },
  {
    prefix: "/accounts/{account_id}/iam/resource_groups",
    ownerKey: "account-settings",
  },
  {
    prefix: "/accounts/{account_id}/iam/user_groups",
    ownerKey: "account-settings",
  },
  { prefix: "/accounts/{account_id}/members", ownerKey: "account-settings" },
  { prefix: "/accounts/{account_id}/roles", ownerKey: "account-settings" },
  {
    prefix: "/accounts/{account_id}/pay-per-crawl/",
    ownerKey: "account-settings",
  },
  { prefix: "/zones/{zone_id}/schema_validation/", ownerKey: "api-gateway" },
  { prefix: "/zones/{zone_id}/token_validation/", ownerKey: "api-gateway" },
];

// Explicit aliases keep firewall permission names aligned with Cloudflare's
// OAuth scope IDs where the official API token group label is not a direct
// slug of that scope. Direct slug cases are handled by normalizeGroupName().
const GROUP_NAME_OVERRIDES = new Map<string, string>([
  ["AI Gateway Read", "aig.read"],
  ["AI Gateway Write", "aig.write"],
  ["Access: Apps and Policies Read", "access-app.read"],
  ["Access: Apps and Policies Revoke", "access-app.revoke"],
  ["Access: Apps and Policies Write", "access-app.write"],
  ["Access: Audit Logs Read", "access-audit-log.read"],
  ["Access: Custom Pages Read", "access-custom-page.read"],
  ["Access: Custom Pages Write", "access-custom-page.write"],
  ["Access: Mutual TLS Certificates Read", "access-certificate.read"],
  ["Access: Mutual TLS Certificates Write", "access-certificate.write"],
  [
    "Access: Organizations, Identity Providers, and Groups Read",
    "access-org.read",
  ],
  [
    "Access: Organizations, Identity Providers, and Groups Revoke",
    "access-org.revoke",
  ],
  [
    "Access: Organizations, Identity Providers, and Groups Write",
    "access-org.write",
  ],
  ["Access: Policy Test Read", "access-policy-test.read"],
  ["Access: Policy Test Write", "access-policy-test.write"],
  ["Access: SCIM Logs Read", "access-scim-log.read"],
  ["Access: Service Tokens Read", "access-service-token.read"],
  ["Access: Service Tokens Write", "access-service-token.write"],
  ["Access: SSH Auditing Read", "access-ssh-auditing.read"],
  ["Access: SSH Auditing Write", "access-ssh-auditing.write"],
  ["Account API Gateway", "account-api-gateway.write"],
  ["Account API Gateway Read", "account-api-gateway.read"],
  ["Account Filter Lists Edit", "account-rule-lists.write"],
  ["Account Filter Lists Read", "account-rule-lists.read"],
  ["Account: SSL and Certificates Read", "account-ssl-and-certificates.read"],
  ["Account: SSL and Certificates Write", "account-ssl-and-certificates.write"],
  ["Allow Request Tracer Read", "request-tracer.read"],
  ["Artifacts Edit", "artifacts.write"],
  ["Auto Rag Read", "rag.read"],
  ["Auto Rag Write", "rag.write"],
  ["Bot Management Feedback Report Read", "bot-management-feedback.read"],
  ["Bot Management Feedback Report Write", "bot-management-feedback.write"],
  ["Cache Purge", "cache.purge"],
  ["Cloud Email Security: Read", "cloud-email-security.read"],
  ["Cloud Email Security: Write", "cloud-email-security.write"],
  ["Cloudflare DEX Read", "teams-dex.read"],
  ["Cloudflare DEX Write", "teams-dex.write"],
  ["Cloudflare One Connector: WARP Read", "teams-connector-warp.read"],
  ["Cloudflare One Connector: WARP Write", "teams-connector-warp.write"],
  [
    "Cloudflare One Connector: cloudflared Read",
    "teams-connector-cloudflared.read",
  ],
  [
    "Cloudflare One Connector: cloudflared Write",
    "teams-connector-cloudflared.write",
  ],
  ["Cloudflare One Connectors Read", "teams-connectors.read"],
  ["Cloudflare One Connectors Write", "teams-connectors.write"],
  ["Cloudflare One Networks Read", "teams-networks.read"],
  ["Cloudflare One Networks Write", "teams-networks.write"],
  ["Cloudflare Tunnel Read", "argotunnel.read"],
  ["Cloudflare Tunnel Write", "argotunnel.write"],
  ["Cloudflare Zero Trust Secure DNS Locations Write", "teams-secure.location"],
  ["DDoS Botnet Feed Read", "ddos-botnet-feed.read"],
  ["DDoS Botnet Feed Write", "ddos-botnet-feed.write"],
  ["DDoS Protection Read", "ddos-protection.read"],
  ["DDoS Protection Write", "ddos-protection.write"],
  ["DNS Read", "dns.read"],
  ["DNS Write", "dns.write"],
  ["Domain API Gateway", "api-gateway.write"],
  ["Domain API Gateway Read", "api-gateway.read"],
  ["Domain Page Shield", "domain-page.shield"],
  ["Domain Page Shield Read", "domain-page-shield.read"],
  ["Dynamic URL Redirects Read", "dynamic-redirect.read"],
  ["Dynamic URL Redirects Write", "dynamic-redirect.write"],
  ["Email Routing Addresses Read", "email-routing-address.read"],
  ["Email Routing Addresses Write", "email-routing-address.write"],
  ["Email Routing Rules Read", "email-routing-rule.read"],
  ["Email Routing Rules Write", "email-routing-rule.write"],
  ["Health Checks Read", "healthcheck.read"],
  ["Health Checks Write", "healthcheck.write"],
  ["Hyperdrive Read", "query-cache.read"],
  ["Hyperdrive Write", "query-cache.write"],
  ["IP Prefixes: BGP On Demand Read", "ip-prefix-bgp-on-demand.read"],
  ["IP Prefixes: BGP On Demand Write", "ip-prefix-bgp-on-demand.write"],
  ["IP Prefixes: Read", "ip-prefix.read"],
  ["IP Prefixes: Write", "ip-prefix.write"],
  ["Load Balancers Account Read", "load-balancers-account.read"],
  ["Load Balancers Account Write", "load-balancers-account.write"],
  [
    "Load Balancing: Monitors and Pools Read",
    "load-balancing-monitors-and-pools.read",
  ],
  [
    "Load Balancing: Monitors and Pools Write",
    "load-balancing-monitors-and-pools.write",
  ],
  ["Magic Firewall Packet Captures - Read PCAPs API", "pcaps-api.read"],
  ["Magic Firewall Packet Captures - Write PCAPs API", "pcaps-api.write"],
  ["Magic Network Monitoring Admin", "fbm.admin"],
  ["Magic Network Monitoring Config Read", "fbm.read"],
  ["Magic Network Monitoring Config Write", "fbm.write"],
  ["Managed headers Read", "managed-headers.read"],
  ["Managed headers Write", "managed-headers.write"],
  ["Page Shield", "page.shield"],
  ["Page Shield Read", "page-shield.read"],
  ["Pages Read", "page.read"],
  ["Pages Write", "page.write"],
  ["Realtime", "realtime.realtime"],
  ["Realtime Admin", "realtime.admin"],
  ["SCIM Provisioning", "scim-provisioning.write"],
  ["Turnstile Sites Read", "challenge-widgets.read"],
  ["Turnstile Sites Write", "challenge-widgets.write"],
  ["Workers AI Read", "ai.read"],
  ["Workers AI Write", "ai.write"],
  ["Workers Containers Read", "containers.read"],
  ["Workers Containers Write", "containers.write"],
  ["Workers R2 Data Catalog Read", "r2-catalog.read"],
  ["Workers R2 Data Catalog Write", "r2-catalog.write"],
  ["Workers R2 Storage Read", "workers-r2.read"],
  ["Workers R2 Storage Write", "workers-r2.write"],
  ["Zaraz Admin", "zaraz.write"],
  ["Zaraz Edit", "zaraz.edit"],
  ["Zaraz Read", "zaraz.read"],
  ["Zero Trust Read", "teams.read"],
  ["Zero Trust Report", "teams.report"],
  ["Zero Trust Resilience Read", "teams-resilience.read"],
  ["Zero Trust Resilience Write", "teams-resilience.write"],
  ["Zero Trust Write", "teams.write"],
  ["Zero Trust: PII Read", "teams-pii.read"],
  ["Zero Trust: Seats Write", "access-seats.write"],
  ["Zone DNS Edit", "dns.write"],
  ["Zone Zone Edit", "zone.write"],
  ["Zone Zone Read", "zone.read"],
]);

const CLOUDFLARE_CATEGORY_LABELS = new Map<string, string>([
  ["account_and_billing", "Account & Billing"],
  ["ai_and_machine_learning", "AI & Machine Learning"],
  ["analytics_and_logs", "Analytics & Logs"],
  ["app_security", "App Security"],
  ["cache_and_performance", "Cache & Performance"],
  ["cloudflare_one", "Cloudflare One / Zero Trust"],
  ["cloudflare_one_and_zero_trust", "Cloudflare One / Zero Trust"],
  ["cloudflare_one_zero_trust", "Cloudflare One / Zero Trust"],
  ["developer_platform", "Developer Platform"],
  ["dns_and_zones", "DNS & Zones"],
  ["email_and_messaging", "Email & Messaging"],
  ["media", "Media"],
  ["network_services", "Network Services"],
  ["other", "Other"],
  ["rules_and_configuration", "Rules & Configuration"],
]);

const API_TOKEN_ONLY_CATEGORY_OVERRIDES = new Map<string, string>([
  ["account-api-tokens.read", "Account & Billing"],
  ["account-api-tokens.write", "Account & Billing"],
  ["api-tokens.read", "Account & Billing"],
  ["api-tokens.write", "Account & Billing"],
  ["billing.read", "Account & Billing"],
  ["billing.write", "Account & Billing"],
  ["oauth-client.read", "Account & Billing"],
  ["oauth-client.write", "Account & Billing"],
  ["sso-connector.read", "Cloudflare One / Zero Trust"],
  ["sso-connector.write", "Cloudflare One / Zero Trust"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    return typeof entry === "string";
  });
}

function categoryLabel(categoryId: string): string {
  const override = CLOUDFLARE_CATEGORY_LABELS.get(categoryId);
  if (override) return override;

  return categoryId
    .split("_")
    .filter((part) => {
      return part !== "";
    })
    .map((part) => {
      if (part === "and") return "&";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function parseOAuthCategoryData(response: unknown): OAuthCategoryData {
  if (!isRecord(response)) {
    throw new Error("Cloudflare OAuth scopes response must be an object");
  }

  if (response.success !== true) {
    throw new Error("Cloudflare OAuth scopes response was not successful");
  }

  if (!Array.isArray(response.result)) {
    throw new Error("Cloudflare OAuth scopes response result must be an array");
  }

  const categoriesByPermission = new Map<string, string>();
  const displayOrder: string[] = [];
  const seenCategories = new Set<string>();

  for (const rawScope of response.result) {
    if (!isRecord(rawScope)) continue;
    if (typeof rawScope.id !== "string") continue;
    if (typeof rawScope.category !== "string") continue;

    const category = categoryLabel(rawScope.category);
    categoriesByPermission.set(rawScope.id, category);
    if (!seenCategories.has(category)) {
      seenCategories.add(category);
      displayOrder.push(category);
    }
  }

  if (categoriesByPermission.size === 0) {
    throw new Error(
      "Cloudflare OAuth scopes response had no categorized scopes",
    );
  }

  return { categoriesByPermission, displayOrder };
}

function hasCfPermissionsRequired(operation: Record<string, unknown>): boolean {
  const value = operation["x-cfPermissionsRequired"];
  return value !== undefined && value !== null;
}

function operationString(
  operation: Record<string, unknown>,
  key: string,
): string | null {
  const value = operation[key];
  return typeof value === "string" ? value : null;
}

function cfPermissionsRequired(operation: Record<string, unknown>): string[] {
  const value = operation["x-cfPermissionsRequired"];
  if (!isRecord(value)) return [];
  return stringArray(value.enum);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function canonicalToken(token: string): string {
  const alias = TOKEN_ALIASES.get(token);
  if (alias) return alias;
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function tokens(value: string): string[] {
  return slugify(value)
    .split("-")
    .filter((token) => {
      return token !== "";
    })
    .map(canonicalToken);
}

function meaningfulOwnerTokens(value: string): string[] {
  return tokens(value).filter((token) => {
    return !WEAK_OWNER_TOKENS.has(token);
  });
}

function splitGroupAction(
  groupName: string,
): { stem: string; action: PermissionAction } | null {
  for (const { suffix, action } of ACTION_SUFFIXES) {
    if (groupName.endsWith(suffix)) {
      return {
        stem: groupName.slice(0, -suffix.length),
        action,
      };
    }
  }
  return null;
}

function permissionOwnerKey(permissionName: string): string {
  const dotIndex = permissionName.lastIndexOf(".");
  if (dotIndex === -1) return permissionName;
  return permissionName.slice(0, dotIndex);
}

function permissionAction(permissionName: string): PermissionAction | null {
  const dotIndex = permissionName.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const suffix = permissionName.slice(dotIndex + 1);
  if (
    suffix === "admin" ||
    suffix === "bind" ||
    suffix === "edit" ||
    suffix === "evaluate" ||
    suffix === "index" ||
    suffix === "location" ||
    suffix === "monitoring" ||
    suffix === "purge" ||
    suffix === "read" ||
    suffix === "realtime" ||
    suffix === "report" ||
    suffix === "revoke" ||
    suffix === "run" ||
    suffix === "send" ||
    suffix === "shield" ||
    suffix === "write"
  ) {
    return suffix;
  }
  return null;
}

function normalizeGroupName(groupName: string): NormalizedPermission | null {
  const split = splitGroupAction(groupName);
  const sourceStem = split?.stem ?? groupName;
  const overriddenName = GROUP_NAME_OVERRIDES.get(groupName);
  if (overriddenName) {
    const action = permissionAction(overriddenName);
    if (!action) return null;
    return {
      name: overriddenName,
      action,
      ownerKey: permissionOwnerKey(overriddenName),
      sourceGroup: groupName,
      sourceStem,
      description: `Cloudflare API token group: ${groupName}`,
    };
  }

  if (!split) return null;

  const slug = slugify(split.stem);
  if (slug === "") return null;

  return {
    name: `${slug}.${split.action}`,
    action: split.action,
    ownerKey: slug,
    sourceGroup: groupName,
    sourceStem: split.stem,
    description: `Cloudflare API token group: ${groupName}`,
  };
}

function sanitizeParamName(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized === "" ? "param" : sanitized;
}

function collapseMultiParamSegments(apiPath: string): string {
  return apiPath
    .split("/")
    .map((segment) => {
      const paramNames = [...segment.matchAll(/\{[+*]?([^}]+)\}/g)].map(
        (match) => {
          return sanitizeParamName(match[1] ?? "");
        },
      );
      if (paramNames.length <= 1) return segment;
      return `{${paramNames.join("_")}}`;
    })
    .join("/");
}

function uniquifyPathParamNames(apiPath: string): string {
  const seenNames = new Map<string, number>();
  return apiPath.replace(/\{([+*]?)([^}]+)\}/g, (match, greedy, rawName) => {
    const name = String(rawName);
    const nextCount = (seenNames.get(name) ?? 0) + 1;
    seenNames.set(name, nextCount);
    if (nextCount === 1) return String(match);
    return `{${String(greedy)}${name}_${nextCount}}`;
  });
}

function sanitizeRulePath(apiPath: string): string {
  return uniquifyPathParamNames(collapseMultiParamSegments(apiPath));
}

function apiPathToRulePath(apiPath: string): string {
  return sanitizeRulePath(`${CLOUDFLARE_API_VERSION_PREFIX}${apiPath}`);
}

function getPermissionGroup(
  permissionGroups: Map<
    string,
    { rules: Set<string>; metadata: NormalizedPermission }
  >,
  metadata: NormalizedPermission,
): { rules: Set<string>; metadata: NormalizedPermission } {
  const existing = permissionGroups.get(metadata.name);
  if (existing) return existing;

  const created = { rules: new Set<string>(), metadata };
  permissionGroups.set(metadata.name, created);
  return created;
}

function operationContext(
  apiPath: string,
  method: string,
  operation: Record<string, unknown>,
): OperationContext {
  return {
    apiPath,
    method,
    tags: stringArray(operation.tags),
    operationId: operationString(operation, "operationId"),
    summary: operationString(operation, "summary"),
    description: operationString(operation, "description"),
    cfPermissionsRequired: cfPermissionsRequired(operation),
  };
}

function ownerText(permission: NormalizedPermission): string[] {
  return [permission.ownerKey, permission.sourceStem, permission.sourceGroup];
}

function contextSearchText(context: OperationContext): string {
  return [
    context.apiPath,
    context.method,
    ...context.tags,
    context.operationId ?? "",
    context.summary ?? "",
    context.description ?? "",
    ...context.cfPermissionsRequired,
  ].join(" ");
}

// Descriptions contain prose like "a set of vectors" or "run a query"; using
// them for read/write token detection makes read-like POST routes look mutating.
function contextActionText(context: OperationContext): string {
  return [
    context.apiPath,
    context.method,
    ...context.tags,
    context.operationId ?? "",
    context.summary ?? "",
    ...context.cfPermissionsRequired,
  ].join(" ");
}

function tokenMatchScore(
  candidateTokens: readonly string[],
  contextTokens: ReadonlySet<string>,
): number {
  const uniqueTokens = [...new Set(candidateTokens)];
  if (uniqueTokens.length === 0) return 0;

  let matchedCount = 0;
  for (const token of uniqueTokens) {
    if (contextTokens.has(token)) {
      matchedCount += 1;
    }
  }
  return matchedCount * 120;
}

function ownerCandidateScore(
  ownerKey: string,
  groups: readonly NormalizedPermission[],
  context: OperationContext,
): number {
  const pathOverrideMatches = PATH_OWNER_OVERRIDES.some((override) => {
    return (
      context.apiPath.startsWith(override.prefix) &&
      override.ownerKey === ownerKey
    );
  });
  if (pathOverrideMatches) return 100_000;

  const tagSlugs = context.tags.map(slugify);
  const tagOverrideMatches = tagSlugs.some((tagSlug) => {
    return TAG_OWNER_OVERRIDES.get(tagSlug) === ownerKey;
  });
  if (tagOverrideMatches) return 100_000;

  const searchSlug = slugify(contextSearchText(context));
  const searchTokens = new Set(tokens(contextSearchText(context)));
  const pathSlug = slugify(context.apiPath);
  const operationSlug = slugify(
    [context.operationId ?? "", context.summary ?? ""].join(" "),
  );
  const cfPermissionSlugs = context.cfPermissionsRequired.map((permission) => {
    return slugify(permission.replace(/^#/, "").replace(/:.*/, ""));
  });

  let score = 0;
  const ownerTexts = new Set<string>();
  for (const group of groups) {
    for (const text of ownerText(group)) {
      ownerTexts.add(text);
    }
  }

  for (const text of ownerTexts) {
    const ownerSlug = slugify(text);
    const ownerTokens = meaningfulOwnerTokens(text);

    for (const tagSlug of tagSlugs) {
      if (tagSlug === ownerSlug) score += 20_000;
      if (tagSlug.includes(ownerSlug) || ownerSlug.includes(tagSlug)) {
        score += 6_000;
      }
      score += tokenMatchScore(ownerTokens, new Set(tokens(tagSlug))) * 12;
    }

    if (pathSlug.includes(ownerSlug)) score += 4_000;
    if (operationSlug.includes(ownerSlug)) score += 3_000;
    if (searchSlug.includes(ownerSlug)) score += 1_000;

    for (const cfPermissionSlug of cfPermissionSlugs) {
      if (
        cfPermissionSlug === ownerSlug ||
        ownerSlug.includes(cfPermissionSlug)
      ) {
        score += 8_000;
      }
      score +=
        tokenMatchScore(ownerTokens, new Set(tokens(cfPermissionSlug))) * 15;
    }

    score += tokenMatchScore(ownerTokens, searchTokens);
  }

  return score;
}

function actionScore(
  permission: NormalizedPermission,
  context: OperationContext,
): number {
  const searchTokens = new Set(tokens(contextSearchText(context)));
  const actionTokens = ACTION_TEXT_TOKENS[permission.action];
  const textMatchScore = actionTokens.some((token) => {
    return searchTokens.has(canonicalToken(token));
  })
    ? 1_000
    : 0;

  return textMatchScore + ACTION_PRIORITY[permission.action];
}

function contextTokenSet(context: OperationContext): ReadonlySet<string> {
  return new Set(tokens(contextActionText(context)));
}

function hasAnyToken(
  tokenSet: ReadonlySet<string>,
  expectedTokens: ReadonlySet<string>,
): boolean {
  for (const token of expectedTokens) {
    if (tokenSet.has(token)) return true;
  }
  return false;
}

function shouldSelectReadAction(context: OperationContext): boolean {
  if (READ_OPERATION_METHODS.has(context.method)) return true;

  const tokenSet = contextTokenSet(context);
  return (
    hasAnyToken(tokenSet, READ_OPERATION_TOKENS) &&
    !hasAnyToken(tokenSet, WRITE_OPERATION_TOKENS)
  );
}

function selectActionGroup(
  groups: readonly NormalizedPermission[],
  context: OperationContext,
): NormalizedPermission | null {
  const readGroup = groups.find((group) => {
    return group.action === "read";
  });
  if (readGroup && shouldSelectReadAction(context)) return readGroup;

  return (
    [...groups].sort((a, b) => {
      const actionScoreDiff = actionScore(b, context) - actionScore(a, context);
      if (actionScoreDiff !== 0) return actionScoreDiff;
      return a.name.localeCompare(b.name);
    })[0] ?? null
  );
}

function actionCandidateGroups(
  groups: readonly NormalizedPermission[],
  context: OperationContext,
): {
  groups: NormalizedPermission[];
  droppedReadGroupCount: number;
} {
  const readGroups = groups.filter((group) => {
    return group.action === "read";
  });
  if (readGroups.length > 0 && shouldSelectReadAction(context)) {
    return { groups: readGroups, droppedReadGroupCount: 0 };
  }

  const nonReadGroups = groups.filter((group) => {
    return group.action !== "read";
  });
  if (nonReadGroups.length > 0) {
    return {
      groups: nonReadGroups,
      droppedReadGroupCount: readGroups.length,
    };
  }

  return { groups: [...groups], droppedReadGroupCount: 0 };
}

function selectOperationGroup(
  normalizedGroups: readonly NormalizedPermission[],
  context: OperationContext,
): {
  group: NormalizedPermission | null;
  hadMultipleGroups: boolean;
  droppedOwnerGroupCount: number;
  selectedOwnerScore: number;
  droppedReadGroupCount: number;
} {
  const uniqueGroupsByName = new Map<string, NormalizedPermission>();
  for (const group of normalizedGroups) {
    uniqueGroupsByName.set(group.name, group);
  }

  const uniqueGroups = [...uniqueGroupsByName.values()];
  const hadMultipleGroups = uniqueGroups.length > 1;
  if (uniqueGroups.length === 0) {
    return {
      group: null,
      hadMultipleGroups,
      droppedOwnerGroupCount: 0,
      selectedOwnerScore: 0,
      droppedReadGroupCount: 0,
    };
  }

  const { groups: candidateGroups, droppedReadGroupCount } =
    actionCandidateGroups(uniqueGroups, context);

  const groupsByOwner = new Map<string, NormalizedPermission[]>();
  for (const group of candidateGroups) {
    const ownerGroups = groupsByOwner.get(group.ownerKey) ?? [];
    ownerGroups.push(group);
    groupsByOwner.set(group.ownerKey, ownerGroups);
  }

  const ownerCandidates = [...groupsByOwner.entries()]
    .map(([ownerKey, groups]) => {
      const firstOfficialIndex = uniqueGroups.findIndex((group) => {
        return group.ownerKey === ownerKey;
      });
      return {
        ownerKey,
        groups,
        firstOfficialIndex,
        score: ownerCandidateScore(ownerKey, groups, context),
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.firstOfficialIndex !== b.firstOfficialIndex) {
        return a.firstOfficialIndex - b.firstOfficialIndex;
      }
      return a.ownerKey.localeCompare(b.ownerKey);
    });

  const selectedOwner = ownerCandidates[0];
  if (!selectedOwner) {
    return {
      group: null,
      hadMultipleGroups,
      droppedOwnerGroupCount: 0,
      selectedOwnerScore: 0,
      droppedReadGroupCount: 0,
    };
  }

  const selectedGroup = selectActionGroup(selectedOwner.groups, context);

  if (!selectedGroup) {
    return {
      group: null,
      hadMultipleGroups,
      droppedOwnerGroupCount: 0,
      selectedOwnerScore: 0,
      droppedReadGroupCount: 0,
    };
  }

  return {
    group: selectedGroup,
    hadMultipleGroups,
    droppedOwnerGroupCount:
      candidateGroups.length - selectedOwner.groups.length,
    selectedOwnerScore: selectedOwner.score,
    droppedReadGroupCount,
  };
}

function assertUniquePermissionRules(
  permissions: readonly PermissionGroup[],
): void {
  const rulePermissions = new Map<string, string[]>();

  for (const permission of permissions) {
    for (const rule of permission.rules) {
      const existing = rulePermissions.get(rule) ?? [];
      existing.push(permission.name);
      rulePermissions.set(rule, existing);
    }
  }

  const conflicts = [...rulePermissions.entries()].filter(([, permissions]) => {
    return permissions.length > 1;
  });
  if (conflicts.length === 0) return;

  const examples = conflicts
    .slice(0, 20)
    .map(([rule, permissionNames]) => {
      return `  - ${rule}: ${permissionNames.join(", ")}`;
    })
    .join("\n");

  throw new Error(
    "Cloudflare generated routes must be assigned to exactly one permission:\n" +
      examples,
  );
}

function buildGroups(
  spec: OpenApiSpec,
  oauthCategoryData: OAuthCategoryData,
): BuildResult {
  if (!spec.paths) {
    throw new Error("OpenAPI spec has no 'paths'");
  }

  const permissionGroups = new Map<
    string,
    { rules: Set<string>; metadata: NormalizedPermission }
  >();
  const unscoredOwnerExamples: string[] = [];
  const stats: BuildStats = {
    totalOperations: 0,
    operationsWithApiTokenGroup: 0,
    operationsWithCfPermissionsRequired: 0,
    mappedOperations: 0,
    unmappedOperations: 0,
    ambiguousOperations: 0,
    multiGroupOperations: 0,
    operationsWithPrioritizedOwners: 0,
    groupsDroppedByOwnerPriority: 0,
    operationsWithUnscoredOwnerSelection: 0,
    operationsWithPrioritizedReadGroups: 0,
    readGroupsDroppedByPriority: 0,
    permissionCount: 0,
  };

  for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
    if (!isRecord(pathItem)) continue;

    for (const [methodLower, rawOperation] of Object.entries(pathItem)) {
      if (!ALL_METHODS.has(methodLower)) {
        if (
          OPENAPI_PATH_KEYS.has(methodLower) ||
          methodLower.startsWith("x-")
        ) {
          continue;
        }
        throw new Error(`Unexpected key '${methodLower}' on ${apiPath}`);
      }
      if (!isRecord(rawOperation)) continue;

      stats.totalOperations += 1;
      if (hasCfPermissionsRequired(rawOperation)) {
        stats.operationsWithCfPermissionsRequired += 1;
      }

      const officialGroups = stringArray(rawOperation["x-api-token-group"]);
      if (officialGroups.length === 0) {
        stats.unmappedOperations += 1;
        continue;
      }
      stats.operationsWithApiTokenGroup += 1;

      const normalizedGroups: NormalizedPermission[] = [];
      let hasAmbiguousGroup = false;
      for (const officialGroup of officialGroups) {
        const normalized = normalizeGroupName(officialGroup);
        if (normalized) {
          normalizedGroups.push(normalized);
        } else {
          hasAmbiguousGroup = true;
        }
      }

      const {
        group: selectedGroup,
        hadMultipleGroups,
        droppedOwnerGroupCount,
        selectedOwnerScore,
        droppedReadGroupCount,
      } = selectOperationGroup(
        normalizedGroups,
        operationContext(apiPath, methodLower, rawOperation),
      );

      if (!selectedGroup) {
        stats.unmappedOperations += 1;
        if (hasAmbiguousGroup) stats.ambiguousOperations += 1;
        continue;
      }

      if (hasAmbiguousGroup) stats.ambiguousOperations += 1;
      if (hadMultipleGroups) stats.multiGroupOperations += 1;
      if (droppedOwnerGroupCount > 0) {
        stats.operationsWithPrioritizedOwners += 1;
        stats.groupsDroppedByOwnerPriority += droppedOwnerGroupCount;
        if (selectedOwnerScore <= 0) {
          stats.operationsWithUnscoredOwnerSelection += 1;
          if (unscoredOwnerExamples.length < 20) {
            unscoredOwnerExamples.push(
              [
                `${methodLower.toUpperCase()} ${apiPath}`,
                `selected: ${selectedGroup.name}`,
                `tags: ${stringArray(rawOperation.tags).join(", ")}`,
                `groups: ${officialGroups.join(", ")}`,
              ].join("\n  "),
            );
          }
        }
      }
      if (droppedReadGroupCount > 0) {
        stats.operationsWithPrioritizedReadGroups += 1;
        stats.readGroupsDroppedByPriority += droppedReadGroupCount;
      }
      stats.mappedOperations += 1;

      const rule = `${methodLower.toUpperCase()} ${apiPathToRulePath(apiPath)}`;
      getPermissionGroup(permissionGroups, selectedGroup).rules.add(rule);
    }
  }

  const permissions = [...permissionGroups.entries()]
    .map(([name, group]) => {
      return {
        name,
        description: group.metadata.description,
        rules: sanitizeAndSortRules([...group.rules]),
      };
    })
    .filter((group) => {
      return group.rules.length > 0;
    })
    .sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

  if (unscoredOwnerExamples.length > 0) {
    throw new Error(
      "Cloudflare owner selection needs an explicit signal for these operations:\n" +
        unscoredOwnerExamples
          .map((example) => {
            return `  - ${example}`;
          })
          .join("\n"),
    );
  }

  const categories: Record<string, string> = {};
  const missingCategoryPermissions: string[] = [];
  for (const permission of permissions) {
    const category =
      oauthCategoryData.categoriesByPermission.get(permission.name) ??
      API_TOKEN_ONLY_CATEGORY_OVERRIDES.get(permission.name);
    if (!category) {
      missingCategoryPermissions.push(permission.name);
      continue;
    }
    categories[permission.name] = category;
  }

  if (missingCategoryPermissions.length > 0) {
    throw new Error(
      "Cloudflare OAuth scopes are missing categories for generated permissions:\n" +
        missingCategoryPermissions
          .sort((a, b) => {
            return a.localeCompare(b);
          })
          .map((name) => {
            return `  - ${name}`;
          })
          .join("\n"),
    );
  }

  const usedCategories = new Set(Object.values(categories));
  const categoryOrder = oauthCategoryData.displayOrder.filter((category) => {
    return usedCategories.has(category);
  });

  const defaultAllowed = permissions
    .filter((permission) => {
      return permissionAction(permission.name) === "read";
    })
    .map((permission) => {
      return permission.name;
    });

  assertUniquePermissionRules(permissions);

  stats.permissionCount = permissions.length;

  return { permissions, categories, categoryOrder, defaultAllowed, stats };
}

function renderStats(stats: BuildStats): string[] {
  return [
    "export const cloudflareGenerationStats = {",
    `  totalOperations: ${stats.totalOperations},`,
    `  operationsWithApiTokenGroup: ${stats.operationsWithApiTokenGroup},`,
    `  operationsWithCfPermissionsRequired: ${stats.operationsWithCfPermissionsRequired},`,
    `  mappedOperations: ${stats.mappedOperations},`,
    `  unmappedOperations: ${stats.unmappedOperations},`,
    `  ambiguousOperations: ${stats.ambiguousOperations},`,
    `  multiGroupOperations: ${stats.multiGroupOperations},`,
    `  operationsWithPrioritizedOwners: ${stats.operationsWithPrioritizedOwners},`,
    `  groupsDroppedByOwnerPriority: ${stats.groupsDroppedByOwnerPriority},`,
    `  operationsWithUnscoredOwnerSelection: ${stats.operationsWithUnscoredOwnerSelection},`,
    `  operationsWithPrioritizedReadGroups: ${stats.operationsWithPrioritizedReadGroups},`,
    `  readGroupsDroppedByPriority: ${stats.readGroupsDroppedByPriority},`,
    `  permissionCount: ${stats.permissionCount},`,
    "} as const;",
    "",
  ];
}

function generateTypeScript(result: BuildResult): string {
  const lines: string[] = [
    "// Auto-generated from Cloudflare's official OpenAPI spec and OAuth scopes.",
    `// Source: ${CLOUDFLARE_OPENAPI_URL}`,
    `// Source: ${CLOUDFLARE_OAUTH_SCOPES_URL}`,
    "// Update sources: cd turbo && pnpm -F @vm0/firewalls-generator update-specs:cloudflare",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:cloudflare",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue, PermissionNamesOf } from "../firewall-types";',
    "",
    "export const cloudflareFirewall = {",
    '  name: "cloudflare",',
    '  description: "Cloudflare API",',
    "  placeholders: {",
    `    CLOUDFLARE_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    `      base: "${CLOUDFLARE_API_BASE}",`,
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(result.permissions));

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");
  lines.push(...renderStats(result.stats));
  lines.push(
    ...renderCategories("cloudflareCategories", "cloudflareFirewall", {
      categories: result.categories,
      displayOrder: result.categoryOrder,
    }),
  );
  lines.push(
    ...renderDefaultAllowed(
      "cloudflareDefaultAllowed",
      "cloudflareFirewall",
      result.defaultAllowed,
    ),
  );
  lines.push(
    ...renderDefaultUnknownPolicy("cloudflareDefaultUnknownPolicy", "deny"),
  );

  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating Cloudflare firewall config...");
  const res = await fetchSpec(
    CLOUDFLARE_OPENAPI_URL,
    "Cloudflare OpenAPI spec",
  );
  const spec = (await res.json()) as OpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const oauthScopesRes = await fetchSpec(
    CLOUDFLARE_OAUTH_SCOPES_URL,
    "Cloudflare OAuth scopes",
  );
  const oauthCategoryData = parseOAuthCategoryData(await oauthScopesRes.json());

  const result = buildGroups(spec, oauthCategoryData);
  const ts = generateTypeScript(result);

  logStats(result.permissions);
  console.error(
    `  ${result.stats.mappedOperations}/${result.stats.totalOperations} operations mapped`,
  );
  writeOutput("cloudflare", ts);
}
