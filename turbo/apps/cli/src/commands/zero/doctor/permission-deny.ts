import { Command, Option } from "commander";
import type { ConnectorPermissionDenyDiagnosticResult } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import {
  hasUnsafeFirewallPath,
  UNKNOWN_PERMISSION_GRANT,
} from "@vm0/connectors/firewall-types";
import { diagnoseZeroConnectorPermissionDeny } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";

interface PermissionDenyOptions {
  readonly method: string;
  readonly url?: string;
  readonly path?: string;
}

type UnsafeInputReason = Extract<
  ConnectorPermissionDenyDiagnosticResult,
  { readonly outcome: "unsafe-input" }
>["reason"];

const VALID_DENIED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function unknownPermissionChangeCommand(connectorRef: string): string {
  return `zero doctor permission-change ${connectorRef} --permission ${UNKNOWN_PERMISSION_GRANT} --enable --duration 1h`;
}

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

function unsafePathError(): Error {
  return new Error(
    "permission-deny cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
  );
}

function parseDeniedMethod(method: string): string {
  const upperMethod = method.toUpperCase();
  if (!VALID_DENIED_METHODS.has(upperMethod)) {
    throw invalidMethodError();
  }
  return upperMethod;
}

function rawAuthorityFromDeniedUrl(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return null;

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = url.indexOf(delimiter, authorityStart);
    if (index !== -1) authorityEnd = Math.min(authorityEnd, index);
  }
  return url.slice(authorityStart, authorityEnd);
}

function rawAuthorityHasUnsafeSyntax(url: string): boolean {
  const authority = rawAuthorityFromDeniedUrl(url);
  if (authority === null) return false;
  return (
    authority === "" ||
    authority.includes("\\") ||
    authority.includes("%") ||
    [...authority].some((char) => {
      return char.charCodeAt(0) > 0x7f;
    })
  );
}

function validateDeniedUrl(url: string): void {
  if (
    !url.includes("://") ||
    /\s/.test(url) ||
    rawAuthorityHasUnsafeSyntax(url)
  ) {
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
  } catch {
    throw invalidUrlError();
  }
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

function printFilteredRequest(
  label: string,
  method: string,
  relativePath: string,
  base: string,
): void {
  console.log(
    `The ${label} permission filtered ${method} ${relativePath} relative to base URL ${base}.`,
  );
}

function unsafeInputError(reason: UnsafeInputReason): Error {
  switch (reason) {
    case "invalid-method":
      return invalidMethodError();
    case "invalid-url":
      return invalidUrlError();
    case "unsafe-path":
      return unsafePathError();
  }
}

function handleDiagnosticResult(
  connectorRef: string,
  method: string,
  result: ConnectorPermissionDenyDiagnosticResult,
): void {
  switch (result.outcome) {
    case "matched":
      printFilteredRequest(
        result.label,
        method,
        result.relativePath,
        result.base,
      );
      printPermissionChangeGuidance(connectorRef, result.permissions);
      return;
    case "unknown-endpoint":
      printFilteredRequest(
        result.label,
        method,
        result.relativePath,
        result.base,
      );
      console.log("No named permission was found covering this request.");
      console.log("This request is governed by the unknown endpoint policy.");
      console.log(
        `To allow unknown endpoints, run: ${unknownPermissionChangeCommand(connectorRef)}`,
      );
      return;
    case "unknown-connector":
      throw new Error(`Unknown connector type: ${connectorRef}`);
    case "no-matching-base":
      throw new Error(
        `No registered ${result.label} base URL matches the provided URL.`,
      );
    case "unresolved-dynamic-base":
      throw new Error(
        `No authoritative ${result.label} base URL is available for this diagnostic. Verify the ${connectorRef} connector configuration for the affected context and retry.`,
      );
    case "unsafe-input":
      throw unsafeInputError(result.reason);
  }

  const exhaustiveResult: never = result;
  return exhaustiveResult;
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
        validateDeniedUrl(opts.url);
        const deniedPath = rawPathFromDeniedUrl(opts.url);
        if (hasUnsafeFirewallPath(deniedPath)) {
          throw unsafePathError();
        }

        if (
          isComputerUsePermissionTarget({
            connectorRef,
            path: deniedPath,
          })
        ) {
          printComputerUsePermissionGuidance();
          return;
        }

        const result = await diagnoseZeroConnectorPermissionDeny(
          connectorRef,
          method,
          stripUrlQueryAndFragment(opts.url),
        );
        handleDiagnosticResult(connectorRef, method, result);
      },
    ),
  );
