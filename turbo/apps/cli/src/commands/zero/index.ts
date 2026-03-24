import { Command } from "commander";
import { zeroOrgCommand } from "./org";
import { agentCommand } from "./agent";
import { zeroConnectorCommand } from "./connector";
import { zeroPreferenceCommand } from "./preference";
import { zeroScheduleCommand } from "./schedule";
import { zeroSecretCommand } from "./secret";
import { zeroVariableCommand } from "./variable";

export const zeroCommand = new Command("zero")
  .description("Zero platform commands")
  .addCommand(zeroOrgCommand)
  .addCommand(agentCommand)
  .addCommand(zeroConnectorCommand)
  .addCommand(zeroPreferenceCommand)
  .addCommand(zeroScheduleCommand)
  .addCommand(zeroSecretCommand)
  .addCommand(zeroVariableCommand);
