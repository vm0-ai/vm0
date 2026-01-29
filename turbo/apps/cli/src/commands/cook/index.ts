import { cookAction } from "./cook";
import { logsCommand } from "./logs";
import { continueCommand } from "./continue";
import { resumeCommand } from "./resume";

// Re-export utilities for testing
export { parseRunIdsFromOutput, CONFIG_FILE } from "./utils";
export { extractRequiredVarNames, checkMissingVariables } from "./cook";

// Add subcommands to the cook command
cookAction.addCommand(logsCommand);
cookAction.addCommand(continueCommand);
cookAction.addCommand(resumeCommand);

export const cookCommand = cookAction;
