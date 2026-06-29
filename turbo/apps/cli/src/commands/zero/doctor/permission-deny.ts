import { Command, Option } from "commander";
import {
  findMatchingRoutingPermissions,
  matchFirewallBaseUrl,
} from "@vm0/connectors/firewall-rule-matcher";
import { getFirewallPermissionSummary } from "@vm0/connectors/firewall-metadata";
import { loadFirewallRoutingMetadata } from "@vm0/connectors/firewall-metadata/routing";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { withErrorHandler } from "../../../lib/command";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";

function unknownPermissionChangeCommand(connectorRef: string): string {
  return `zero doctor permission-change ${connectorRef} --permission ${UNKNOWN_PERMISSION_GRANT} --enable --duration 1h`;
}

interface PermissionDenyOptions {
  readonly method: string;
  readonly url?: string;
  readonly path?: string;
}

interface PermissionDenyBaseMatch {
  readonly apiBase: string;
  readonly displayBase: string;
  readonly relativePath: string;
  readonly score: number;
}

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const WHOLE_BASE_URL_VAR_PATTERN =
  /^\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/;
const VALID_DENIED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function pathOnlyError(): Error {
  return new Error(
    "permission-deny now requires --url because method/path alone can match the wrong API base.",
  );
}

function invalidUrlError(): Error {
  return new Error(
    "permission-deny requires --url to be a valid absolute http or https URL.",
  );
}

function invalidMethodError(): Error {
  return new Error(
    "permission-deny requires --method to be one of GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.",
  );
}

function parseDeniedMethod(method: string): string {
  const upperMethod = method.toUpperCase();
  if (!VALID_DENIED_METHODS.has(upperMethod)) {
    throw invalidMethodError();
  }
  return upperMethod;
}

function parseDeniedUrl(url: string): URL {
  if (!url.includes("://") || /\s/.test(url) || url.includes("\\")) {
    throw invalidUrlError();
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw invalidUrlError();
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw invalidUrlError();
    }
    return parsed;
  } catch {
    throw invalidUrlError();
  }
}

function baseUrlTemplateVarNames(base: string): string[] {
  return [...base.matchAll(BASE_URL_VAR_PATTERN)].map((match) => {
    return match[1]!;
  });
}

function wholeBaseUrlTemplateVarName(base: string): string | null {
  return WHOLE_BASE_URL_VAR_PATTERN.exec(base)?.[1] ?? null;
}

function resolveBaseUrlTemplateFromEnv(base: string): string | null {
  const names = baseUrlTemplateVarNames(base);
  if (names.length === 0) return base;

  let missing = false;
  const resolved = base.replace(
    BASE_URL_VAR_PATTERN,
    (_match, name: string) => {
      const value = process.env[name];
      if (!value) {
        missing = true;
        return "";
      }
      return value;
    },
  );
  return missing ? null : resolved;
}

function baseUrlTemplateToPattern(base: string): string | null {
  if (baseUrlTemplateVarNames(base).length === 0) return null;
  const pattern = base.replace(BASE_URL_VAR_PATTERN, (_match, name: string) => {
    return `{${name}}`;
  });
  return pattern.includes("://") ? pattern : null;
}

function connectorRefHostToken(connectorRef: string): string {
  return connectorRef.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function hostnameMatchesConnectorRef(url: URL, connectorRef: string): boolean {
  const token = connectorRefHostToken(connectorRef);
  if (token.length < 3) return false;
  return (url.hostname || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => {
      return part === token;
    });
}

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function rawPathFromDeniedUrl(url: string): string {
  const urlWithoutQuery = stripUrlQueryAndFragment(url);
  const schemeEnd = urlWithoutQuery.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = urlWithoutQuery.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : urlWithoutQuery.slice(pathStart);
}

function matchApiBaseUrl(
  url: string,
  apiBase: string,
): PermissionDenyBaseMatch | null {
  const directMatch = matchFirewallBaseUrl(url, apiBase);
  if (directMatch) {
    return {
      apiBase,
      displayBase: directMatch.displayBase,
      relativePath: directMatch.relativePath,
      score: directMatch.score,
    };
  }

  const resolvedBase = resolveBaseUrlTemplateFromEnv(apiBase);
  if (resolvedBase !== null && resolvedBase !== apiBase) {
    const resolvedMatch = matchFirewallBaseUrl(url, resolvedBase);
    if (resolvedMatch) {
      return {
        apiBase,
        displayBase: resolvedMatch.displayBase,
        relativePath: resolvedMatch.relativePath,
        score: resolvedMatch.score,
      };
    }
    return null;
  }

  const patternBase = baseUrlTemplateToPattern(apiBase);
  if (patternBase === null) return null;
  const patternMatch = matchFirewallBaseUrl(url, patternBase);
  if (!patternMatch) return null;
  return {
    apiBase,
    displayBase: apiBase,
    relativePath: patternMatch.relativePath,
    score: patternMatch.score,
  };
}

function findBestBaseMatch(
  url: string,
  deniedUrl: URL,
  connectorRef: string,
  apis: readonly { readonly base: string }[],
): PermissionDenyBaseMatch | null {
  let bestMatch: PermissionDenyBaseMatch | null = null;
  for (const api of apis) {
    const match = matchApiBaseUrl(url, api.base);
    if (match && (!bestMatch || match.score > bestMatch.score)) {
      bestMatch = match;
    }
  }
  if (bestMatch !== null) return bestMatch;

  const unresolvedWholeBaseApis = apis.filter((api) => {
    const name = wholeBaseUrlTemplateVarName(api.base);
    return name !== null && !process.env[name];
  });
  if (unresolvedWholeBaseApis.length !== 1) return null;
  if (!hostnameMatchesConnectorRef(deniedUrl, connectorRef)) return null;

  const api = unresolvedWholeBaseApis[0]!;
  return {
    apiBase: api.base,
    displayBase: api.base,
    relativePath: rawPathFromDeniedUrl(url),
    score: 0,
  };
}

function printPermissionChangeGuidance(
  connectorRef: string,
  permissions: readonly string[],
): void {
  const sortedPermissions = [...permissions].sort();
  if (sortedPermissions.length === 1) {
    const permission = sortedPermissions[0]!;
    console.log(`This is covered by the "${permission}" permission.`);
    console.log(
      `To allow this permission, run: zero doctor permission-change ${connectorRef} --permission ${permission} --enable --duration 1h`,
    );
    return;
  }

  console.log(
    `This is covered by these permissions: ${sortedPermissions.join(", ")}.`,
  );
  for (const permission of sortedPermissions) {
    console.log(
      `To allow ${permission}, run: zero doctor permission-change ${connectorRef} --permission ${permission} --enable --duration 1h`,
    );
  }
}

export const permissionDenyCommand = new Command()
  .name("permission-deny")
  .description(
    "Diagnose a permission denial and find the permission that covers it",
  )
  .argument("<connector-ref>", "The connector type (e.g. github)")
  .addOption(
    new Option(
      "--method <method>",
      "The denied HTTP method",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--url <url>",
      "The denied request URL; query strings are ignored (required)",
    ),
  )
  .addOption(new Option("--path <path>", "Deprecated: use --url").hideHelp())
  .addHelpText(
    "after",
    `
Examples:
  zero doctor permission-deny github --method GET --url https://api.github.com/repos/owner/repo/pulls
  zero doctor permission-deny slack --method POST --url https://slack.com/api/chat.postMessage
  zero doctor permission-deny youtube --method PUT --url https://youtube.googleapis.com/upload/youtube/v3/videos

Notes:
  - Identifies which named permission covers a denied request
  - If the firewall denial response includes a url field, pass that value to --url
  - Requires the denied URL origin and path because method/path alone can match the wrong API base
  - Query strings and fragments are ignored for matching; omit them when they may contain secrets
  - Use permission-change to request or enable the permission
  - Permission-change enable requests default to --duration 1h; pick 24h, 7d, or always only when appropriate`,
  )
  .action(
    withErrorHandler(
      async (connectorRef: string, opts: PermissionDenyOptions) => {
        if (opts.path !== undefined) {
          throw pathOnlyError();
        }
        if (!opts.url) {
          throw pathOnlyError();
        }
        const method = parseDeniedMethod(opts.method);
        const deniedUrl = parseDeniedUrl(opts.url);
        const deniedPath = rawPathFromDeniedUrl(opts.url);

        if (
          isComputerUsePermissionTarget({
            connectorRef,
            path: deniedPath,
          })
        ) {
          printComputerUsePermissionGuidance();
          return;
        }

        const metadata = await loadFirewallRoutingMetadata(connectorRef);
        if (!metadata) {
          throw new Error(`Unknown connector type: ${connectorRef}`);
        }

        const label =
          getFirewallPermissionSummary(connectorRef)?.label ?? connectorRef;
        const match = findBestBaseMatch(
          opts.url,
          deniedUrl,
          connectorRef,
          metadata.apis,
        );
        if (!match) {
          throw new Error(
            `No registered ${label} base URL matches the provided URL.`,
          );
        }

        const permissions = findMatchingRoutingPermissions(
          method,
          match.relativePath,
          metadata.apis,
          { apiBase: match.apiBase, serviceName: connectorRef },
        );

        console.log(
          `The ${label} permission filtered ${method} ${match.relativePath} relative to base URL ${match.displayBase}.`,
        );

        if (permissions.length === 0) {
          console.log("No named permission was found covering this request.");
          console.log(
            "This request is governed by the unknown endpoint policy.",
          );
          console.log(
            `To allow unknown endpoints, run: ${unknownPermissionChangeCommand(connectorRef)}`,
          );
          return;
        }

        printPermissionChangeGuidance(connectorRef, permissions);
      },
    ),
  );
