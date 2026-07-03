import {
  type FirewallConfig,
  UNKNOWN_PERMISSION_GRANT,
  validateAuthBaseUrl,
  validateBaseUrlHostPolicy,
  validateBaseUrl,
} from "./firewall-types";
import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";
import { parseSegment, splitPathSegments } from "./segment-parser";

const VALID_RULE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ANY",
]);

function validatePathSegments(
  path: string,
  rule: string,
  permName: string,
  serviceName: string,
): void {
  if (!path.startsWith("/")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must start with "/"`,
    );
  }
  if (hasRawWhitespace(path)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain whitespace`,
    );
  }
  if (hasUnsafeUrlCodepoint(path)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain control characters or invalid Unicode`,
    );
  }
  if (path.includes("\\")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain backslash`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": path must not contain query string or fragment`,
    );
  }
  const segments = splitPathSegments(path);
  const paramNames = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const parsed = parseSegment(seg);
    if (parsed.kind === "error") {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": ${parsed.reason}`,
      );
    }
    if (parsed.kind === "literal") continue;
    const { name, greedy, prefix, suffix } = parsed;
    if (paramNames.has(name)) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": duplicate parameter name "{${name}}"`,
      );
    }
    paramNames.add(name);
    if (greedy && i !== segments.length - 1) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": {${name}${greedy}} must be the last segment`,
      );
    }
    if (greedy && (prefix !== "" || suffix !== "")) {
      throw new Error(
        `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": greedy parameter {${name}${greedy}} cannot be combined with a literal prefix or suffix in segment "${seg}"`,
      );
    }
  }
}

export function validateRule(
  rule: string,
  permName: string,
  serviceName: string,
): void {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx === -1) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  const method = rule.slice(0, spaceIdx);
  const rest = rule.slice(spaceIdx + 1);
  if (!method || !rest) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": must be "METHOD /path"`,
    );
  }
  if (!VALID_RULE_METHODS.has(method)) {
    throw new Error(
      `Invalid rule "${rule}" in permission "${permName}" of firewall "${serviceName}": unknown method "${method}" (must be uppercase)`,
    );
  }

  validatePathSegments(rest, rule, permName, serviceName);
}

/**
 * Collect available permission names from a firewall config.
 * Validates uniqueness and that "all" is not used as a permission name.
 */
export function collectAndValidatePermissions(
  serviceConfig: FirewallConfig,
): Set<string> {
  if (serviceConfig.apis.length === 0) {
    throw new Error(`Firewall "${serviceConfig.name}" has no api entries`);
  }
  const available = new Set<string>();
  for (const api of serviceConfig.apis) {
    validateBaseUrl(api.base, serviceConfig.name);
    validateBaseUrlHostPolicy({
      base: api.base,
      serviceName: serviceConfig.name,
      hostPolicy: api.hostPolicy,
    });
    if (api.auth.base !== undefined) {
      validateAuthBaseUrl(api.auth.base, serviceConfig.name);
    }
    if (!api.permissions || api.permissions.length === 0) {
      // Empty permissions is a valid shape: every request under this base
      // falls through to the firewall's unknownPolicy. Auth headers are
      // still injected on base URL match.
      continue;
    }
    // Uniqueness is enforced within a single api_entry. The same permission
    // name across different api_entries is allowed (e.g., "full-access" on
    // both slack.com/api and files.slack.com).
    const seen = new Set<string>();
    for (const perm of api.permissions) {
      if (!perm.name) {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission with empty name`,
        );
      }
      if (perm.name === "all" || perm.name === UNKNOWN_PERMISSION_GRANT) {
        throw new Error(
          `Firewall "${serviceConfig.name}" has a permission named "${perm.name}", which is a reserved keyword`,
        );
      }
      if (seen.has(perm.name)) {
        throw new Error(
          `Duplicate permission name "${perm.name}" in API entry "${api.base}" of firewall "${serviceConfig.name}"`,
        );
      }
      if (perm.rules.length === 0) {
        throw new Error(
          `Permission "${perm.name}" in firewall "${serviceConfig.name}" has no rules`,
        );
      }
      for (const rule of perm.rules) {
        validateRule(rule, perm.name, serviceConfig.name);
      }
      seen.add(perm.name);
      available.add(perm.name);
    }
  }
  return available;
}
