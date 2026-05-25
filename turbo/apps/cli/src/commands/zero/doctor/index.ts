import { Command } from "commander";
import { checkConnectorCommand } from "./check-connector";
import { generateCommand } from "./generate";
import { permissionDenyCommand } from "./permission-deny";
import { permissionChangeCommand } from "./permission-change";
import { creditCommand } from "./credit";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (connector health, permission denials)")
  .addCommand(checkConnectorCommand)
  .addCommand(generateCommand)
  .addCommand(creditCommand)
  .addCommand(permissionDenyCommand)
  .addCommand(permissionChangeCommand)
  .addHelpText(
    "after",
    `
Examples:
  Check a connector?     zero doctor check-connector --env-name GITHUB_TOKEN
  Check a URL?           zero doctor check-connector --url https://api.github.com/repos/owner/repo
  Generate with image?   zero doctor generate image
  Generate with video?   zero doctor generate video
  Check credits?         zero doctor credit
  Check with permission? zero doctor check-connector --env-name SLACK_TOKEN --check-permission chat:write
  Permission denied?     zero doctor permission-deny github --method GET --path /repos/owner/repo
  Change a permission?   zero doctor permission-change github --permission contents:read --enable

Notes:
  - Use zero doctor credit when a run or generation fails because the org has insufficient credits, when a user asks how to recharge, or before trying to buy credits
  - Use this when your task fails due to a missing environment variable or permission denial
  - The doctor will identify the issue and give the user a link to resolve it`,
  );
