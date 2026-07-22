import { Command, Option } from "commander";
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
import {
  addRequestedCallbackSearchParams,
  connectorActionCallbackAvailable,
  printCallbackTurnInstruction,
} from "./action-url";

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
}): void {
  console.log(
    `You can allow ${permissionDescription(args.permission)} for your connector access: [Manage ${args.label} permissions](${args.url})`,
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
  agentId: string | undefined,
  callbackPrompt: string | undefined,
): Promise<void> {
  const platformOrigin = await getPlatformOrigin();

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: "allow",
  });
  addRequestedCallbackSearchParams(urlParams, callbackPrompt, agentId);

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  printSensitivePermissionGuidance(connectorRef, permission);
  printPermissionRequestMessage({
    permission,
    label,
    url,
  });
  if (callbackPrompt !== undefined) {
    printCallbackTurnInstruction();
  }
}

const callbackPromptOption = new Option(
  "--callback-prompt <prompt>",
  "Start the next web chat round with this prompt after the permission is granted",
);
const callbackPromptAvailable = connectorActionCallbackAvailable();
if (!callbackPromptAvailable) {
  callbackPromptOption.hideHelp();
}
const callbackPromptExample = callbackPromptAvailable
  ? '  zero connector permission-request github --permission contents:write --callback-prompt "Re-check the permission, then continue the previous task"\n'
  : "";
const callbackPromptNotes = callbackPromptAvailable
  ? "  - Use --callback-prompt only when this turn needs exactly one connector or permission action\n  - Callback prompts are included in the URL; keep them concise and do not include secrets\n"
  : "";

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
      "--agent <id>",
      "Agent ID whose permission page should be opened (defaults to ZERO_AGENT_ID)",
    ),
  )
  .addOption(callbackPromptOption)
  .addHelpText(
    "after",
    `
Examples:
  zero connector permission-request github --permission contents:read
${callbackPromptExample}  zero connector permission-request gmail --permission messages.write --agent <agent-id>
  zero connector permission-request cloudflare --permission __unknown__
  zero connector permission-request computer-use --permission computer-use:write

Notes:
  - Outputs a platform URL for the user to allow the permission
  - Use --permission __unknown__ to request access to unknown endpoints
  - Use --agent to request a permission for another agent; defaults to ZERO_AGENT_ID
  - The user chooses the permission duration on the confirmation page
${callbackPromptNotes}  - Permission requests update the current user's connector grants after confirmation`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          agent?: string;
          callbackPrompt?: string;
        },
      ) => {
        if (
          isComputerUsePermissionTarget({
            connectorRef,
            permission: opts.permission,
          })
        ) {
          if (opts.callbackPrompt !== undefined) {
            throw new Error(
              "--callback-prompt is not supported for Computer Use authorization requests",
            );
          }
          await printComputerUsePermissionRequestMessage();
          return;
        }

        const agentId = opts.agent ?? process.env.ZERO_AGENT_ID;

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
          agentId,
          opts.callbackPrompt,
        );
      },
    ),
  );
