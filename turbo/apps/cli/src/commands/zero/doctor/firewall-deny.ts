import { Command, Option } from "commander";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  findMatchingPermissions,
  CONNECTOR_TYPES,
} from "@vm0/core";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";

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

        const pagePath = agentId
          ? `/firewall-allow/${agentId}`
          : "/firewall-allow";
        const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

        console.log(
          `The ${label} firewall blocked ${opts.method} ${opts.path}.`,
        );

        if (permissions.length > 0) {
          console.log(`This is covered by the "${permissions[0]}" permission.`);
        } else {
          console.log("No named permission was found covering this request.");
        }

        console.log(
          `Ask the user to allow it at: [Allow ${label} access](${url})`,
        );
      },
    ),
  );
