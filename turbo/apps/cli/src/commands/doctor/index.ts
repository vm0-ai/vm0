import { Command } from "commander";
import { creditCommand } from "./credit";

export const doctorCommand = new Command()
  .name("doctor")
  .description("Diagnose account and runtime issues")
  .addCommand(creditCommand)
  .addHelpText(
    "after",
    `
Examples:
  Check credits? okou doctor credit

Notes:
  - Use okou doctor credit when a run or generation fails because the org has insufficient credits, when a user asks how to recharge, or before trying to buy credits
  - Use okou generate <type> (no --prompt) to see every provider available for a given generation type
  - Use okou connector check for connector and permission diagnostics`,
  );
