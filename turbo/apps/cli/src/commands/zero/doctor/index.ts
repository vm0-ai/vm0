import { Command } from "commander";
import { checkConnectorCommand } from "./check-connector";
import { permissionDenyCommand } from "./permission-deny";
import { permissionChangeCommand } from "./permission-change";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (connector health, permission denials)")
  .addCommand(checkConnectorCommand)
  .addCommand(permissionDenyCommand)
  .addCommand(permissionChangeCommand)
  .addHelpText(
    "after",
    `
Examples:
  Check a connector?     zero doctor check-connector --env-name GITHUB_TOKEN
  Check a URL?           zero doctor check-connector --url https://api.github.com/repos/owner/repo
  Check with permission? zero doctor check-connector --env-name SLACK_TOKEN --check-permission chat:write
  Permission denied?     zero doctor permission-deny github --method GET --path /repos/owner/repo
  Change a permission?   zero doctor permission-change github --permission contents:read --enable

Notes:
  - Use this when your task fails due to a missing environment variable or permission denial
  - The doctor will identify the issue and give the user a link to resolve it`,
  );
