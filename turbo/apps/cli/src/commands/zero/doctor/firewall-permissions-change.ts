import { Command, Option } from "commander";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  CONNECTOR_TYPES,
} from "@vm0/core";
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
 * Core logic for outputting a firewall permission change message.
 * Shared by both `firewall-permissions-change` and `firewall-deny` commands.
 */
const REASON_MAX_LENGTH = 500;

async function outputPermissionChangeMessage(
  firewallRef: string,
  permission: string,
  action: "enable" | "disable",
  reason?: string,
): Promise<void> {
  const { label } =
    CONNECTOR_TYPES[firewallRef as keyof typeof CONNECTOR_TYPES];

  const platformOrigin = await getPlatformOrigin();
  const agentId = process.env.ZERO_AGENT_ID;
  const role = agentId ? await resolveAgentRole(agentId) : "unknown";

  const urlParams = new URLSearchParams({
    ref: firewallRef,
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
    firewallRef === "slack" &&
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

  if (role === "admin" || role === "owner") {
    console.log(
      `You can ${action} the "${permission}" permission directly: [Manage ${label} firewall](${url})`,
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
        `Permission changes require admin approval. Contact an org admin to disable this permission: [View ${label} firewall](${url})`,
      );
    }
  } else {
    console.log(
      `To ${action} the "${permission}" permission on the ${label} firewall: [Manage ${label} firewall](${url})`,
    );
  }
}

export const firewallPermissionsChangeCommand = new Command()
  .name("firewall-permissions-change")
  .description("Request a firewall permission change (enable or disable)")
  .argument("<firewall-ref>", "The firewall connector type (e.g. github)")
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
  zero doctor firewall-permissions-change github --permission contents:read --enable
  zero doctor firewall-permissions-change slack --permission chat:write --disable

Notes:
  - Outputs a platform URL for the user to adjust the permission
  - Admins can change permissions directly; members must request approval`,
  )
  .action(
    withErrorHandler(
      async (
        firewallRef: string,
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

        if (!isFirewallConnectorType(firewallRef)) {
          throw new Error(`Unknown firewall connector type: ${firewallRef}`);
        }

        if (!findPermissionInConfig(firewallRef, opts.permission)) {
          throw new Error(
            `Unknown permission "${opts.permission}" for ${firewallRef} firewall`,
          );
        }

        const action = opts.enable ? "enable" : "disable";
        await outputPermissionChangeMessage(
          firewallRef,
          opts.permission,
          action,
          opts.reason,
        );
      },
    ),
  );
