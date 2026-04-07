import { Command, Option } from "commander";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  findMatchingPermissions,
  CONNECTOR_TYPES,
} from "@vm0/core";
import { withErrorHandler } from "../../../lib/command";

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
  - Use firewall-permissions-change to request or enable the permission`,
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

        console.log(
          `The ${label} firewall blocked ${opts.method} ${opts.path}.`,
        );

        if (permissions.length === 0) {
          console.log("No named permission was found covering this request.");
          return;
        }

        const permission = permissions[0]!;
        console.log(`This is covered by the "${permission}" permission.`);
        console.log(
          `To request this permission, run: zero doctor firewall-permissions-change ${firewallRef} --permission ${permission} --enable --reason "why this is needed"`,
        );
      },
    ),
  );
