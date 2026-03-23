import { Command } from "commander";
import { zeroOrgCommand } from "./org";
import { agentCommand } from "./agent";

export const zeroCommand = new Command("zero")
  .description("Zero platform commands")
  .addCommand(zeroOrgCommand)
  .addCommand(agentCommand);
