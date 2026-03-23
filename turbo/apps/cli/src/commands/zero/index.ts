import { Command } from "commander";
import { zeroOrgCommand } from "./org";
import { agentCommand } from "./agent";
import { zeroSecretCommand } from "./secret";
import { zeroVariableCommand } from "./variable";

export const zeroCommand = new Command("zero")
  .description("Zero platform commands")
  .addCommand(zeroOrgCommand)
  .addCommand(agentCommand)
  .addCommand(zeroSecretCommand)
  .addCommand(zeroVariableCommand);
