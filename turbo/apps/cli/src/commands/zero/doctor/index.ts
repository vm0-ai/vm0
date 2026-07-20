import { Command } from "commander";
import { creditCommand } from "./credit";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose account and runtime issues")
  .addCommand(creditCommand)
  .addHelpText(
    "after",
    `
Examples:
  Check credits? zero doctor credit

Notes:
  - Use zero doctor credit when a run or generation fails because the org has insufficient credits, when a user asks how to recharge, or before trying to buy credits
  - Use zero generate <type> (no --prompt) to see every provider available for a given generation type
  - Use zero connector check for connector and permission diagnostics`,
  );
