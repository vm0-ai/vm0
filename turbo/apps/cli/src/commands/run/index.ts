import { mainRunCommand } from "./run";
import { resumeCommand } from "./resume";
import { continueCommand } from "./continue";

// Add subcommands to the main run command
mainRunCommand.addCommand(resumeCommand);
mainRunCommand.addCommand(continueCommand);

export const runCommand = mainRunCommand;
