import { Command, Option } from "commander";
import {
  type FirewallBaseUrlMatch,
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

function pathOnlyError(): Error {
  return new Error(
    "permission-deny now requires --url because method/path alone can match the wrong API base.",
  );
}

function urlPath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function findBestBaseMatch(
  url: string,
  apis: readonly { readonly base: string }[],
): FirewallBaseUrlMatch | null {
  let bestMatch: FirewallBaseUrlMatch | null = null;
  for (const api of apis) {
    const match = matchFirewallBaseUrl(url, api.base);
    if (match && (!bestMatch || match.score > bestMatch.score)) {
      bestMatch = match;
    }
  }
  return bestMatch;
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

        if (
          isComputerUsePermissionTarget({
            connectorRef,
            path: urlPath(opts.url),
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
        const match = findBestBaseMatch(opts.url, metadata.apis);
        if (!match) {
          throw new Error(
            `No registered ${label} base URL matches the provided URL.`,
          );
        }

        const method = opts.method.toUpperCase();
        const permissions = findMatchingRoutingPermissions(
          method,
          match.relativePath,
          metadata.apis,
          { apiBase: match.displayBase, serviceName: connectorRef },
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
