import { Command, Option } from "commander";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  findFirewallMetadataPermission,
  loadFirewallPermissionMetadata,
} from "@vm0/connectors/firewall-metadata";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";
import {
  ApiRequestError,
  createComputerUseAuthorizationRequest,
} from "../../../lib/api";

const DEFAULT_PERMISSION_GRANT_DURATION: UserPermissionGrantExpiresIn = "1h";
const PERMISSION_GRANT_DURATIONS = [
  "1h",
  "24h",
  "7d",
  "always",
] as const satisfies readonly UserPermissionGrantExpiresIn[];

type PermissionAction = "enable" | "disable";

function permissionDescription(permission: string): string {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? "unknown endpoints"
    : `the "${permission}" permission`;
}

function printSensitivePermissionGuidance(
  connectorRef: string,
  permission: string,
  action: PermissionAction,
): void {
  if (action !== "enable") return;

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

function printPermissionActionMessage(args: {
  readonly action: PermissionAction;
  readonly permission: string;
  readonly label: string;
  readonly url: string;
  readonly duration: UserPermissionGrantExpiresIn | undefined;
}): void {
  const grantAction = args.action === "enable" ? "allow" : "deny";
  console.log(
    `You can ${grantAction} ${permissionDescription(args.permission)} for your connector access: [Manage ${args.label} permissions](${args.url})`,
  );
  if (args.duration) {
    console.log(
      `Requested duration: ${args.duration}. Use --duration 1h|24h|7d|always to choose a different grant lifetime.`,
    );
  }
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

async function printComputerUsePermissionChangeMessage(
  action: PermissionAction,
): Promise<void> {
  if (action !== "enable") {
    printComputerUsePermissionGuidance();
    return;
  }

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

function resolveTriggerContext():
  | { workflowId: string; triggerId: string }
  | undefined {
  const triggerId = process.env.ZERO_WORKFLOW_TRIGGER_ID;
  const workflowId = process.env.ZERO_WORKFLOW_ID;
  return triggerId && workflowId ? { workflowId, triggerId } : undefined;
}

async function outputPermissionChangeMessage(
  connectorRef: string,
  label: string,
  permission: string,
  action: PermissionAction,
  duration: UserPermissionGrantExpiresIn | undefined,
  agentId: string | undefined,
  triggerContext: { workflowId: string; triggerId: string } | undefined,
): Promise<void> {
  const platformOrigin = await getPlatformOrigin();

  // Trigger-fired runs configure permissions on the workflow-user grant store,
  // shared by all triggers the same user owns for the workflow. Deep-link to
  // the workflow Authorization tab for the relevant connector and permission.
  if (triggerContext && agentId) {
    const workflowUrlParams = new URLSearchParams({
      tab: "authorization",
      ref: connectorRef,
      permission,
      action: action === "enable" ? "allow" : "deny",
    });
    if (action === "enable") {
      workflowUrlParams.set(
        "expiresIn",
        duration ?? DEFAULT_PERMISSION_GRANT_DURATION,
      );
    }
    const workflowUrl = `${platformOrigin}/agents/${agentId}/workflows/${triggerContext.workflowId}?${workflowUrlParams.toString()}`;
    printSensitivePermissionGuidance(connectorRef, permission, action);
    printPermissionActionMessage({
      action,
      permission,
      label,
      url: workflowUrl,
      duration:
        action === "enable"
          ? (duration ?? DEFAULT_PERMISSION_GRANT_DURATION)
          : undefined,
    });
    return;
  }

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: action === "enable" ? "allow" : "deny",
  });
  if (action === "enable") {
    urlParams.set("expiresIn", duration ?? DEFAULT_PERMISSION_GRANT_DURATION);
  }

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  printSensitivePermissionGuidance(connectorRef, permission, action);
  printPermissionActionMessage({
    action,
    permission,
    label,
    url,
    duration:
      action === "enable"
        ? (duration ?? DEFAULT_PERMISSION_GRANT_DURATION)
        : undefined,
  });
}

export const permissionChangeCommand = new Command()
  .name("permission-change")
  .description("Change or request a permission (enable or disable)")
  .argument("<connector-ref>", "The connector type (e.g. github)")
  .addOption(
    new Option(
      "--permission <name>",
      "The permission name to change",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--enable",
      "Enable or request enabling the permission",
    ).conflicts("disable"),
  )
  .addOption(
    new Option(
      "--disable",
      "Disable or request disabling the permission",
    ).conflicts("enable"),
  )
  .addOption(
    new Option(
      "--duration <duration>",
      "Requested allow duration: 1h, 24h, 7d, or always (default: 1h)",
    ).choices([...PERMISSION_GRANT_DURATIONS]),
  )
  .addOption(
    new Option("--reason <text>", "Brief reason for the permission change"),
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
  zero doctor permission-change github --permission contents:read --enable
  zero doctor permission-change github --permission contents:write --enable --duration 24h
  zero doctor permission-change gmail --permission messages.write --enable --agent <agent-id>
  zero doctor permission-change slack --permission chat:write --disable
  zero doctor permission-change cloudflare --permission __unknown__ --disable
  zero doctor permission-change computer-use --permission computer-use:write --enable

Notes:
  - Outputs a platform URL for the user to adjust the permission
  - Use --permission __unknown__ to change unknown endpoint policy
  - Use --agent to request a permission for another agent; defaults to ZERO_AGENT_ID
  - Enable requests default to --duration 1h; use 24h or 7d for longer user-approved work
  - Use --duration always only when the user explicitly asks for persistent access
  - Permission changes update the current user's connector grants`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          enable?: boolean;
          disable?: boolean;
          duration?: UserPermissionGrantExpiresIn;
          reason?: string;
          agent?: string;
        },
      ) => {
        if (!opts.enable && !opts.disable) {
          throw new Error("Either --enable or --disable is required");
        }
        if (opts.disable && opts.duration !== undefined) {
          throw new Error("--duration is only supported with --enable");
        }

        if (
          isComputerUsePermissionTarget({
            connectorRef,
            permission: opts.permission,
          })
        ) {
          await printComputerUsePermissionChangeMessage(
            opts.enable ? "enable" : "disable",
          );
          return;
        }

        const metadata = await loadFirewallPermissionMetadata(connectorRef);
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

        const action = opts.enable ? "enable" : "disable";
        await outputPermissionChangeMessage(
          connectorRef,
          metadata.label,
          opts.permission,
          action,
          opts.duration,
          opts.agent ?? process.env.ZERO_AGENT_ID,
          resolveTriggerContext(),
        );
      },
    ),
  );
