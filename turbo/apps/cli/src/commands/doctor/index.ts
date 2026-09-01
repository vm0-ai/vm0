import { Command } from "commander";
import { connectorsCommand } from "./connectors";
import { creditCommand } from "./credit";

export const doctorCommand = new Command()
  .name("doctor")
  .description("Diagnose account and runtime issues")
  .addCommand(connectorsCommand)
  .addCommand(creditCommand)
  .addHelpText(
    "after",
    `
Examples:
  Check credits? okou doctor credit
  Check workflow connectors? okou doctor connectors
  Check one workflow? okou doctor connectors <workflow> --agent <agent-id>
  Print a structured report? okou doctor connectors --json

Notes:
  - Use okou doctor credit when a run or generation fails because the org has insufficient credits, when a user asks how to recharge, or before trying to buy credits
  - Use okou generate <type> (no --prompt) to see every provider available for a given generation type
  - Use okou doctor connectors for stored connector readiness across effective visible workflows on every visible Agent
  - Use okou connector check for one current-run URL, environment name, firewall decision, or permission failure`,
  );
