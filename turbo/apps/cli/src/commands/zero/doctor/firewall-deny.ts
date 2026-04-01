import { Command, Option } from "commander";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  findMatchingPermissions,
  CONNECTOR_TYPES,
} from "@vm0/core";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";
import { resolveRole } from "./resolve-role";

export const firewallDenyCommand = new Command()
  .name("firewall-deny")
  .description(
    "Diagnose a firewall denial and find the permission that covers it",
  )
  .argument("<firewall-ref>", "The firewall connector type (e.g. github)")
  .addOption(
    new Option(
      "--method <method>",
      "The denied HTTP method",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option("--path <path>", "The denied path").makeOptionMandatory(),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor firewall-deny github --method GET --path /repos/owner/repo/pulls
  zero doctor firewall-deny slack --method POST --path /chat.postMessage

Notes:
  - Identifies which named permission covers a denied request
  - Outputs a platform URL for the user to allow the permission`,
  )
  .action(
    withErrorHandler(
      async (firewallRef: string, opts: { method: string; path: string }) => {
        if (!isFirewallConnectorType(firewallRef)) {
          throw new Error(`Unknown firewall connector type: ${firewallRef}`);
        }

        const { label } = CONNECTOR_TYPES[firewallRef];
        const config = getConnectorFirewall(firewallRef);
        const permissions = findMatchingPermissions(
          opts.method,
          opts.path,
          config,
        );

        const platformOrigin = await getPlatformOrigin();
        const agentId = process.env.ZERO_AGENT_ID;

        const urlParams = new URLSearchParams({
          ref: firewallRef,
          method: opts.method,
          path: opts.path,
        });

        if (permissions.length > 0) {
          urlParams.set("permission", permissions[0]!);
        }

        const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
        const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

        console.log(
          `The ${label} firewall blocked ${opts.method} ${opts.path}.`,
        );

        if (permissions.length > 0) {
          console.log(`This is covered by the "${permissions[0]}" permission.`);
        } else {
          console.log("No named permission was found covering this request.");
        }

        // Slack chat:write: strongly recommend bot-based messaging over user identity
        if (firewallRef === "slack" && permissions[0] === "chat:write") {
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

        const role = agentId ? await resolveRole() : "unknown";

        if (role === "admin") {
          console.log(
            `You can allow this permission directly: [Manage ${label} firewall](${url})`,
          );
        } else if (role === "member") {
          console.log(
            `This change requires admin approval. Request access at: [Request ${label} access](${url})`,
          );
        } else {
          console.log(
            `Ask the user to allow it at: [Allow ${label} access](${url})`,
          );
        }
      },
    ),
  );
