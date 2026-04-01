import { Command, Option } from "commander";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  CONNECTOR_TYPES,
} from "@vm0/core";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";
import { resolveRole } from "./resolve-role";

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
        opts: { permission: string; enable?: boolean; disable?: boolean },
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

        const { label } = CONNECTOR_TYPES[firewallRef];
        const action = opts.enable ? "enable" : "disable";

        const platformOrigin = await getPlatformOrigin();
        const agentId = process.env.ZERO_AGENT_ID;

        const urlParams = new URLSearchParams({
          ref: firewallRef,
          permission: opts.permission,
        });

        const pagePath = agentId
          ? `/firewall-allow/${agentId}`
          : "/firewall-allow";
        const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

        const role = agentId ? await resolveRole() : "unknown";

        if (role === "admin") {
          console.log(
            `You can ${action} the "${opts.permission}" permission directly: [Manage ${label} firewall](${url})`,
          );
        } else if (role === "member") {
          if (action === "enable") {
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
            `To ${action} the "${opts.permission}" permission on the ${label} firewall: [Manage ${label} firewall](${url})`,
          );
        }
      },
    ),
  );
