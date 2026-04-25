import { Command, Option } from "commander";
import { CONNECTOR_TYPES } from "@vm0/api-contracts/contracts/connectors";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/api-contracts/firewalls";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";
import { resolveAgentRole } from "./resolve-role";

function findPermissionInConfig(ref: string, permissionName: string): boolean {
  if (!isFirewallConnectorType(ref)) return false;
  const config = getConnectorFirewall(ref);
  for (const api of config.apis) {
    if (!api.permissions) continue;
    for (const p of api.permissions) {
      if (p.name === permissionName) return true;
    }
  }
  return false;
}

/**
 * Core logic for outputting a permission change message.
 * Shared by both `permission-change` and `permission-deny` commands.
 */
const REASON_MAX_LENGTH = 500;

async function outputPermissionChangeMessage(
  connectorRef: string,
  permission: string,
  action: "enable" | "disable",
  reason?: string,
): Promise<void> {
  const { label } =
    CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];

  const platformOrigin = await getPlatformOrigin();
  const agentId = process.env.ZERO_AGENT_ID;
  const role = agentId ? await resolveAgentRole(agentId) : "unknown";

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: action === "enable" ? "allow" : "deny",
  });

  // Only include reason for member role (admin/owner can change directly)
  if (role === "member" && reason) {
    const truncated =
      reason.length > REASON_MAX_LENGTH
        ? reason.slice(0, REASON_MAX_LENGTH)
        : reason;
    urlParams.set("reason", truncated);
  }

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  // Slack chat:write: strongly recommend bot-based messaging over user identity
  if (
    connectorRef === "slack" &&
    permission === "chat:write" &&
    action === "enable"
  ) {
    console.log("");
    console.log(
      "IMPORTANT: Granting chat:write allows sending messages AS THE USER's identity, not as a bot.",
    );
    console.log(
      "Use `zero slack message send -c <channel> -t <text>` to send messages as the bot instead — this is the recommended approach for most use cases.",
    );
    console.log(
      "Only request user approval below if acting as the user is specifically required.",
    );
    console.log("");
  }

  // Gmail gmail.send: strongly recommend draft-based workflow over direct send
  if (
    connectorRef === "gmail" &&
    permission === "gmail.send" &&
    action === "enable"
  ) {
    console.log("");
    console.log(
      "IMPORTANT: Granting gmail.send allows the agent to send emails directly as the user.",
    );
    console.log(
      "Consider keeping gmail.send disabled and using gmail.compose instead — the agent can create drafts for the user to review and send manually.",
    );
    console.log(
      "Only request user approval below if direct sending is specifically required.",
    );
    console.log("");
  }

  if (role === "admin" || role === "owner") {
    console.log(
      `You can ${action} the "${permission}" permission directly: [Manage ${label} permissions](${url})`,
    );
  } else if (role === "member") {
    if (!reason) {
      console.log(
        `IMPORTANT: Re-run with \`--reason "one sentence why this is needed"\` so the admin can review your request faster.`,
      );
    } else if (action === "enable") {
      console.log(
        `Permission changes require admin approval. Request access at: [Request ${label} access](${url})`,
      );
    } else {
      console.log(
        `Permission changes require admin approval. Contact an org admin to disable this permission: [View ${label} permissions](${url})`,
      );
    }
  } else {
    console.log(
      `To ${action} the "${permission}" permission for ${label}: [Manage ${label} permissions](${url})`,
    );
  }
}

export const permissionChangeCommand = new Command()
  .name("permission-change")
  .description("Request a permission change (enable or disable)")
  .argument("<connector-ref>", "The connector type (e.g. github)")
  .addOption(
    new Option(
      "--permission <name>",
      "The permission name to change",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option("--enable", "Request to enable the permission").conflicts(
      "disable",
    ),
  )
  .addOption(
    new Option("--disable", "Request to disable the permission").conflicts(
      "enable",
    ),
  )
  .addOption(
    new Option(
      "--reason <text>",
      "Brief reason why the permission is needed (max 500 chars)",
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor permission-change github --permission contents:read --enable
  zero doctor permission-change slack --permission chat:write --disable

Notes:
  - Outputs a platform URL for the user to adjust the permission
  - Admins can change permissions directly; members must request approval`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          enable?: boolean;
          disable?: boolean;
          reason?: string;
        },
      ) => {
        if (!opts.enable && !opts.disable) {
          throw new Error("Either --enable or --disable is required");
        }

        if (!isFirewallConnectorType(connectorRef)) {
          throw new Error(`Unknown connector type: ${connectorRef}`);
        }

        if (!findPermissionInConfig(connectorRef, opts.permission)) {
          throw new Error(
            `Unknown permission "${opts.permission}" for ${connectorRef}`,
          );
        }

        const action = opts.enable ? "enable" : "disable";
        await outputPermissionChangeMessage(
          connectorRef,
          opts.permission,
          action,
          opts.reason,
        );
      },
    ),
  );
