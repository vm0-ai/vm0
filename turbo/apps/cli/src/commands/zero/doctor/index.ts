import { Command } from "commander";
import { missingTokenCommand } from "./missing-token";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (missing tokens, connectors)")
  .addCommand(missingTokenCommand)
  .addHelpText(
    "after",
    `
Examples:
  Missing an API key?    zero doctor missing-token GITHUB_TOKEN

Notes:
  - Use this when your task fails due to a missing environment variable
  - The doctor will identify which connector provides the token and give the user a link to connect it`,
  );
