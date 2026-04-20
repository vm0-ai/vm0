import { mainRunCommand } from "./run";
import { resumeCommand } from "./resume";
import { continueCommand } from "./continue";
import { listCommand } from "./list";
import { killCommand } from "./kill";
import { queueCommand } from "./queue";

// Add subcommands to the main run command
mainRunCommand.addCommand(resumeCommand);
mainRunCommand.addCommand(continueCommand);
mainRunCommand.addCommand(listCommand);
mainRunCommand.addCommand(killCommand);
mainRunCommand.addCommand(queueCommand);

export const runCommand = mainRunCommand;
