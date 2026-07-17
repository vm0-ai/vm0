import { Command, Option } from "commander";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { findFirewallMetadataPermission } from "@vm0/connectors/firewall-metadata/policy";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "../doctor/platform-url";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";
import {
  ApiRequestError,
  createComputerUseAuthorizationRequest,
  getZeroConnectorCatalogPermissions,
} from "../../../lib/api";

const DEFAULT_PERMISSION_GRANT_DURATION: UserPermissionGrantExpiresIn = "1h";
const PERMISSION_GRANT_DURATIONS = [
  "1h",
  "24h",
  "7d",
  "always",
] as const satisfies readonly UserPermissionGrantExpiresIn[];

function permissionDescription(permission: string): string {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? "unknown endpoints"
    : `the "${permission}" permission`;
}

function printSensitivePermissionGuidance(
  connectorRef: string,
  permission: string,
): void {
  // Slack chat:write: strongly recommend bot-based messaging over user identity
  if (connectorRef === "slack" && permission === "chat:write") {
    console.log("");
    console.log(
      "IMPORTANT: Granting chat:write allows sending messages AS THE USER's identity, not as a bot.",
    );
    console.log(
      "Use `zero slack message send -c <channel> -t <text>` to send messages as the bot instead — this is the recommended approach for most use cases.",
    );
    console.log(
      "Only allow this permission below if acting as the user is specifically required.",
    );
    console.log("");
  }

  // Gmail send permissions: strongly recommend draft-based workflow over direct send.
  if (
    connectorRef === "gmail" &&
    (permission === "messages.send" || permission === "drafts.send")
  ) {
    console.log("");
    console.log(
      "IMPORTANT: Granting Gmail send permissions allows the agent to send emails directly as the user.",
    );
    console.log(
      "Consider keeping messages.send and drafts.send disabled and using drafts.write instead — the agent can create drafts for the user to review and send manually.",
    );
    console.log(
      "Only allow this permission below if direct sending is specifically required.",
    );
    console.log("");
  }
}

function printPermissionRequestMessage(args: {
  readonly permission: string;
  readonly label: string;
  readonly url: string;
  readonly duration: UserPermissionGrantExpiresIn;
}): void {
  console.log(
    `You can allow ${permissionDescription(args.permission)} for your connector access: [Manage ${args.label} permissions](${args.url})`,
  );
  console.log(
    `Requested duration: ${args.duration}. Use --duration 1h|24h|7d|always to choose a different grant lifetime.`,
  );
}

function printComputerUseAuthorizationLink(args: {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}): void {
  console.log(
    "Computer Use needs a Zero Desktop host selected before a run starts.",
  );
  console.log(
    "Ask the user to authorize a host for future runs in this chat or Slack thread:",
  );
  console.log(args.authorizationUrl);
  console.log(
    `This link expires at ${args.expiresAt}. Existing run tokens cannot be upgraded in place; start a new run after authorization.`,
  );
}

async function printComputerUsePermissionRequestMessage(): Promise<void> {
  if (!process.env.ZERO_TOKEN) {
    printComputerUsePermissionGuidance();
    return;
  }

  try {
    const request = await createComputerUseAuthorizationRequest();
    printComputerUseAuthorizationLink({
      authorizationUrl: request.authorizationUrl,
      expiresAt: request.expiresAt,
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      console.log(
        `Computer Use authorization link unavailable: ${error.message}`,
      );
      printComputerUsePermissionGuidance();
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.log(`Computer Use authorization link unavailable: ${message}`);
    printComputerUsePermissionGuidance();
  }
}

async function outputPermissionRequestMessage(
  connectorRef: string,
  label: string,
  permission: string,
  duration: UserPermissionGrantExpiresIn,
  agentId: string | undefined,
): Promise<void> {
  const platformOrigin = await getPlatformOrigin();

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: "allow",
    expiresIn: duration,
  });

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  printSensitivePermissionGuidance(connectorRef, permission);
  printPermissionRequestMessage({
    permission,
    label,
    url,
    duration,
  });
}

export const permissionRequestCommand = new Command()
  .name("permission-request")
  .description("Request permission to use a connector capability")
  .argument("<connector-ref>", "The connector type (e.g. github)")
  .addOption(
    new Option(
      "--permission <name>",
      "The permission name to request",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--duration <duration>",
      "Requested allow duration: 1h, 24h, 7d, or always",
    )
      .choices([...PERMISSION_GRANT_DURATIONS])
      .default(DEFAULT_PERMISSION_GRANT_DURATION),
  )
  .addOption(
    new Option(
      "--agent <id>",
      "Agent ID whose permission page should be opened (defaults to ZERO_AGENT_ID)",
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero connector permission-request github --permission contents:read
  zero connector permission-request github --permission contents:write --duration 24h
  zero connector permission-request gmail --permission messages.write --agent <agent-id>
  zero connector permission-request cloudflare --permission __unknown__
  zero connector permission-request computer-use --permission computer-use:write

Notes:
  - Outputs a platform URL for the user to allow the permission
  - Use --permission __unknown__ to request access to unknown endpoints
  - Use --agent to request a permission for another agent; defaults to ZERO_AGENT_ID
  - Requests default to --duration 1h; use 24h or 7d for longer user-approved work
  - Use --duration always only when the user explicitly asks for persistent access
  - Permission requests update the current user's connector grants after confirmation`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          duration: UserPermissionGrantExpiresIn;
          agent?: string;
        },
      ) => {
        if (
          isComputerUsePermissionTarget({
            connectorRef,
            permission: opts.permission,
          })
        ) {
          await printComputerUsePermissionRequestMessage();
          return;
        }

        const metadata = await getZeroConnectorCatalogPermissions(connectorRef);
        if (!metadata) {
          throw new Error(`Unknown connector type: ${connectorRef}`);
        }

        if (
          opts.permission !== UNKNOWN_PERMISSION_GRANT &&
          !findFirewallMetadataPermission(metadata, opts.permission)
        ) {
          throw new Error(
            `Unknown permission "${opts.permission}" for ${connectorRef}`,
          );
        }

        await outputPermissionRequestMessage(
          connectorRef,
          metadata.label,
          opts.permission,
          opts.duration,
          opts.agent ?? process.env.ZERO_AGENT_ID,
        );
      },
    ),
  );
