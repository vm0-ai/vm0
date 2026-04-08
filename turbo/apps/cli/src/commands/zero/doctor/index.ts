import { Command } from "commander";
import { missingTokenCommand } from "./missing-token";
import { permissionDenyCommand } from "./permission-deny";
import { permissionChangeCommand } from "./permission-change";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (missing tokens, permission denials)")
  .addCommand(missingTokenCommand)
  .addCommand(permissionDenyCommand)
  .addCommand(permissionChangeCommand)
  .addHelpText(
    "after",
    `
Examples:
  Missing an API key?    zero doctor missing-token GITHUB_TOKEN
  Permission denied?     zero doctor permission-deny github --method GET --path /repos/owner/repo
  Change a permission?   zero doctor permission-change github --permission contents:read --enable

Notes:
  - Use this when your task fails due to a missing environment variable or permission denial
  - The doctor will identify the issue and give the user a link to resolve it`,
  );
