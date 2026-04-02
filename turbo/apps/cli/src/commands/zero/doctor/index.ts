import { Command } from "commander";
import { missingTokenCommand } from "./missing-token";
import { firewallDenyCommand } from "./firewall-deny";
import { firewallPermissionsChangeCommand } from "./firewall-permissions-change";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (missing tokens, firewall denials)")
  .addCommand(missingTokenCommand)
  .addCommand(firewallDenyCommand)
  .addCommand(firewallPermissionsChangeCommand)
  .addHelpText(
    "after",
    `
Examples:
  Missing an API key?    zero doctor missing-token GITHUB_TOKEN
  Firewall blocked?      zero doctor firewall-deny github --method GET --path /repos/owner/repo
  Change a permission?   zero doctor firewall-permissions-change github --permission contents:read --enable

Notes:
  - Use this when your task fails due to a missing environment variable or firewall denial
  - The doctor will identify the issue and give the user a link to resolve it`,
  );
