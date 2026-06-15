import { Command, Option } from "commander";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import { findMatchingPermissions } from "@vm0/connectors/firewall-rule-matcher";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { withErrorHandler } from "../../../lib/command";

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
    new Option("--path <path>", "The denied path").makeOptionMandatory(),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor permission-deny github --method GET --path /repos/owner/repo/pulls
  zero doctor permission-deny slack --method POST --path /chat.postMessage

Notes:
  - Identifies which named permission covers a denied request
  - Use permission-change to request or enable the permission
  - Permission-change enable requests default to --duration 1h; pick 24h, 7d, or always only when appropriate`,
  )
  .action(
    withErrorHandler(
      async (connectorRef: string, opts: { method: string; path: string }) => {
        if (!isFirewallConnectorType(connectorRef)) {
          throw new Error(`Unknown connector type: ${connectorRef}`);
        }

        const { label } = CONNECTOR_TYPES[connectorRef];
        const config = getConnectorFirewall(connectorRef);
        const permissions = findMatchingPermissions(
          opts.method,
          opts.path,
          config,
        );

        console.log(
          `The ${label} permission filtered ${opts.method} ${opts.path}.`,
        );

        if (permissions.length === 0) {
          console.log("No named permission was found covering this request.");
          return;
        }

        // Count total rules per permission name across all APIs
        const ruleCount = new Map<string, number>();
        for (const api of config.apis) {
          if (!api.permissions) continue;
          for (const perm of api.permissions) {
            ruleCount.set(
              perm.name,
              (ruleCount.get(perm.name) ?? 0) + perm.rules.length,
            );
          }
        }

        // Pick the permission with the fewest rules (most specific)
        const permission = permissions.reduce((narrowest, current) => {
          return (ruleCount.get(current) ?? Infinity) <
            (ruleCount.get(narrowest) ?? Infinity)
            ? current
            : narrowest;
        });
        console.log(`This is covered by the "${permission}" permission.`);
        console.log(
          `To allow this permission, run: zero doctor permission-change ${connectorRef} --permission ${permission} --enable --duration 1h`,
        );
      },
    ),
  );
